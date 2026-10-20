from pathlib import Path
import re
from typing import Any, Dict, List, Optional

from .interface import ProtocolClient, TransferError

USB_ERROR = 1
PROGRAM_NUMBER_RE = re.compile(r"(?:^|\n)\s*O(\d+)\b", re.IGNORECASE)
PA_MARKER_PROGRAM_RE = re.compile(r"<\s*O(\d+)\.P[1-3]\s*>", re.IGNORECASE)
PA_FILE_ASSIGNMENT_RE = re.compile(r"&F=/O(\d+)/", re.IGNORECASE)
COMMENT_RE = re.compile(r"\(([^)]*)\)")
FILE_NUMBER_RE = re.compile(r"O(\d+)", re.IGNORECASE)
PATH_DIR_CANDIDATES = {
    1: ("PATH1", "P1", "CH1"),
    2: ("PATH2", "P2", "CH2"),
    3: ("PATH3", "P3", "CH3"),
}
ALLOWED_SUFFIXES = {"", ".mpf", ".spf", ".nc", ".txt", ".p1", ".p2", ".p3", ".pa", ".eia", ".min", ".m", ".s"}
MAX_PROGRAM_FILE_BYTES = 10 * 1024 * 1024
DRIVE_ONLY_RE = re.compile(r"^[A-Za-z]:$")


class UsbTransferClient(ProtocolClient):
    def __init__(self):
        self.root_path: Optional[Path] = None

    @staticmethod
    def _normalize_usb_path(raw_path: str) -> Path:
        cleaned = raw_path.strip().strip('"').strip("'")
        if DRIVE_ONLY_RE.match(cleaned):
            cleaned = f"{cleaned}/"
        return Path(cleaned).expanduser()

    def connect(self, ip: str, port: Optional[int] = None, timeout: int = 10, **kwargs) -> bool:
        if not ip or ip.strip() == "" or ip == "DEMO":
             raise TransferError(USB_ERROR, "Please enter or select a valid local folder path.", "invalid path")

        try:
            root_path = self._normalize_usb_path(ip)
            exists_and_dir = root_path.exists() and root_path.is_dir()
        except OSError as exc:
            self.root_path = None
            raise TransferError(USB_ERROR, f"USB Path '{ip}' cannot be accessed: {exc}", "invalid path") from exc

        if not exists_and_dir:
            self.root_path = None
            raise TransferError(USB_ERROR, f"USB Path '{ip}' does not exist or is not a directory.", "invalid path")
        self.root_path = root_path
        return True

    def disconnect(self):
        self.root_path = None

    def set_path(self, path_no: int):
        self._get_storage_dir(path_no)

    def delete_program(self, prog_num: int, path_no: int = 0):
        storage_dir = self._get_storage_dir(path_no or 1)
        program_entry = self._find_program_entry(storage_dir, prog_num, path_no or 1)
        if not program_entry:
            raise TransferError(USB_ERROR, f"Program O{prog_num} not found on USB path {path_no or 1}", "not found")
        program_entry["file_path"].unlink()

    def download_program(self, program_text: str, path_no: int = 0, file_extension: Optional[str] = None):
        storage_dir = self._require_root_path()
        normalized = self._normalize_program_text(program_text)
        program_number = self._extract_program_number(normalized)
        if program_number is None:
            raise TransferError(USB_ERROR, "USB upload requires an O-number in the program header", "missing program number")

        if file_extension is not None:
            # Use the machine-config-derived extension supplied by the client
            stripped = file_extension.lstrip(".")
            target_file = (
                storage_dir / f"O{program_number:04d}.{stripped}"
                if stripped
                else storage_dir / f"O{program_number:04d}"
            )
        else:
            # Legacy fallback
            ext = f"P{path_no}" if path_no > 0 else "PA"
            target_file = storage_dir / f"O{program_number:04d}.{ext}"
        try:
            target_file.write_text(normalized, encoding="utf-8", newline="\n")
        except OSError as exc:
            raise TransferError(USB_ERROR, f"Failed to write program to '{target_file}': {exc}", "write error") from exc

    def upload_program(self, prog_num: int, path_no: int = 0, file_extensions: Optional[List[str]] = None) -> str:
        storage_dir = self._get_storage_dir(path_no or 1)
        program_entry = self._find_program_entry(storage_dir, prog_num, path_no or 1, file_extensions)
        if not program_entry:
            raise TransferError(USB_ERROR, f"Program O{prog_num} not found on USB path {path_no or 1}", "not found")
        return program_entry["program_text"]

    def list_programs(self, path_no: int = 0, file_extensions: Optional[List[str]] = None) -> list:
        storage_dirs = self._get_list_dirs(path_no or 1)
        if not storage_dirs:
            return []

        allowed_suffixes = self._normalize_extensions(file_extensions)
        programs: List[Dict[str, Any]] = []
        seen_numbers = set()
        for storage_dir in storage_dirs:
            for file_path in self._iter_storage_files(storage_dir):
                if file_path.suffix.lower() not in ALLOWED_SUFFIXES:
                    continue
                if allowed_suffixes is not None and file_path.suffix.lower() not in allowed_suffixes:
                    continue

                program_entry = self._parse_program_file(file_path)
                if program_entry is None or program_entry["number"] in seen_numbers:
                    continue

                seen_numbers.add(program_entry["number"])
                programs.append({
                    "number": program_entry["number"],
                    "length": len(program_entry["program_text"].encode("utf-8")),
                    "comment": program_entry["comment"],
                    "file_extension": program_entry["file_path"].suffix,
                })

        return sorted(programs, key=lambda item: item["number"])

    @staticmethod
    def _iter_storage_files(storage_dir: Path) -> List[Path]:
        try:
            entries = sorted(storage_dir.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return []

        files: List[Path] = []
        for entry in entries:
            try:
                if entry.is_file():
                    files.append(entry)
            except OSError:
                continue
        return files

    def _get_list_dirs(self, path_no: int) -> List[Path]:
        return [self._require_root_path()]

    def _get_storage_dir(self, path_no: int, create: bool = False, allow_missing: bool = False) -> Optional[Path]:
        return self._require_root_path()

    def _require_root_path(self) -> Path:
        if self.root_path is None:
            raise TransferError(USB_ERROR, "USB storage is not connected", "not connected")
        return self.root_path

    def _find_program_entry(self, storage_dir: Path, prog_num: int, path_no: int, file_extensions: Optional[List[str]] = None) -> Optional[Dict[str, Any]]:
        configured_extensions = self._normalize_extensions(file_extensions)
        preferred_extensions = list(configured_extensions) if configured_extensions is not None else [f".p{path_no}".lower()]
        fallback_entry = None
        for file_path in self._iter_storage_files(storage_dir):
            if file_path.suffix.lower() not in ALLOWED_SUFFIXES:
                continue
            program_entry = self._parse_program_file(file_path)
            if program_entry and program_entry["number"] == prog_num:
                if file_path.suffix.lower() in preferred_extensions or (path_no == 0 and file_path.suffix.lower() == ".pa"):
                    return program_entry
                if configured_extensions is None:
                    fallback_entry = program_entry
        return fallback_entry

    @staticmethod
    def _normalize_extensions(file_extensions: Optional[List[str]]) -> Optional[set[str]]:
        if file_extensions is None:
            return None
        return {f".{extension.lstrip('.').lower()}" if extension else "" for extension in file_extensions}

    def _parse_program_file(self, file_path: Path) -> Optional[Dict[str, Any]]:
        try:
            stat = file_path.stat()
            if stat.st_size > MAX_PROGRAM_FILE_BYTES:
                return None
            try:
                program_text = file_path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                program_text = file_path.read_text(encoding="latin-1")
        except OSError:
            return None

        normalized = self._normalize_program_text(program_text)
        number = self._extract_program_number(normalized)
        if number is None:
            match = FILE_NUMBER_RE.search(file_path.stem)
            if not match:
                return None
            number = int(match.group(1))

        return {
            "number": number,
            "comment": self._extract_comment(normalized, file_path.stem),
            "program_text": normalized,
            "file_path": file_path,
        }

    @staticmethod
    def _normalize_program_text(program_text: str) -> str:
        normalized = program_text.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not normalized.startswith("%"):
            normalized = f"%\n{normalized}"
        if not normalized.rstrip().endswith("%"):
            normalized = f"{normalized.rstrip()}\n%"
        return normalized + ("\n" if not normalized.endswith("\n") else "")

    @staticmethod
    def _extract_program_number(program_text: str) -> Optional[int]:
        match = PROGRAM_NUMBER_RE.search(program_text)
        if not match:
            match = PA_MARKER_PROGRAM_RE.search(program_text)
        if not match:
            match = PA_FILE_ASSIGNMENT_RE.search(program_text)
        if not match:
            return None
        return int(match.group(1))

    @staticmethod
    def _extract_comment(program_text: str, fallback: str) -> str:
        match = COMMENT_RE.search(program_text)
        return match.group(1).strip() if match else fallback