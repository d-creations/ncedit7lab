from pathlib import Path
import re
from typing import Any, Dict, List, Optional

from .interface import ProtocolClient, TransferError

USB_ERROR = 1
PROGRAM_NUMBER_RE = re.compile(r"(?:^|\n)\s*O(\d+)\b", re.IGNORECASE)
PA_MARKER_PROGRAM_RE = re.compile(r"<\s*O(\d+)\.P\d+\s*>", re.IGNORECASE)
PA_SECTION_RE = re.compile(r"<\s*(?:O\d+\.)?P(\d+)\s*>", re.IGNORECASE)
PA_FILE_ASSIGNMENT_RE = re.compile(r"&F=/O(\d+)/", re.IGNORECASE)
COMMENT_RE = re.compile(r"\(([^)]*)\)")
FILE_NUMBER_RE = re.compile(r"O(\d+)", re.IGNORECASE)
PATH_DIR_CANDIDATES = {
    1: ("PATH1", "P1", "CH1"),
    2: ("PATH2", "P2", "CH2"),
    3: ("PATH3", "P3", "CH3"),
}
ALLOWED_SUFFIXES = {"", ".mpf", ".spf", ".nc", ".txt", ".p1", ".p2", ".p3", ".pa", ".eia", ".min", ".m", ".s"}
EXCLUDED_SUFFIXES = {
    ".dll", ".exe", ".so", ".dylib", ".zip", ".tar", ".gz", ".7z", ".rar",
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".db", ".sqlite", ".pyc",
}
PATH_SUFFIX_RE = re.compile(r"^\.p-?(\d+)$", re.IGNORECASE)
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
        program_entry = self._find_program_entry(storage_dir, prog_num, path_no, file_extensions)
        if not program_entry:
            raise TransferError(USB_ERROR, f"Program O{prog_num} not found on USB path {path_no or 1}", "not found")
        return program_entry["program_text"]

    def list_programs(self, path_no: int = 0, file_extensions: Optional[List[str]] = None) -> list:
        storage_dirs = self._get_list_dirs(path_no or 1)
        if not storage_dirs:
            return []

        allowed_suffixes = self._normalize_extensions(file_extensions)
        programs: List[Dict[str, Any]] = []
        seen_keys = set()
        for storage_dir in storage_dirs:
            for file_path in self._iter_storage_files(storage_dir):
                if not self._is_candidate_program_file(file_path):
                    continue
                if allowed_suffixes is not None and file_path.suffix.lower() not in allowed_suffixes:
                    continue

                program_entry = self._parse_program_file(file_path)
                if program_entry is None:
                    continue

                # When scanning all USB files (path_no == 0 and no extension filter),
                # keep every distinct (number, extension) entry so O1234.P1, O1234.P2, O1234.M, O1234.S, O1234.PA, and O1234 (no ext) are all listed.
                dedup_key = (
                    (program_entry["number"], file_path.suffix.lower())
                    if path_no == 0 and allowed_suffixes is None
                    else program_entry["number"]
                )
                if dedup_key in seen_keys:
                    continue

                seen_keys.add(dedup_key)
                item: Dict[str, Any] = {
                    "number": program_entry["number"],
                    "length": len(program_entry["program_text"].encode("utf-8")),
                    "comment": program_entry["comment"],
                    "file_extension": program_entry["file_path"].suffix,
                }
                if program_entry.get("is_multipath"):
                    item["is_multipath"] = True
                    item["channels"] = program_entry["channels"]
                programs.append(item)

        return sorted(programs, key=lambda item: (item["number"], item.get("file_extension", "").lower()))

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

    @staticmethod
    def _is_candidate_program_file(file_path: Path) -> bool:
        if file_path.name.startswith("."):
            return False
        suffix = file_path.suffix.lower()
        if suffix in EXCLUDED_SUFFIXES:
            return False
        if suffix in ALLOWED_SUFFIXES or PATH_SUFFIX_RE.match(suffix):
            return True
        return True

    def _find_program_entry(self, storage_dir: Path, prog_num: int, path_no: int, file_extensions: Optional[List[str]] = None) -> Optional[Dict[str, Any]]:
        configured_extensions = self._normalize_extensions(file_extensions)
        effective_path = path_no or 1
        preferred_extensions = (
            list(configured_extensions)
            if configured_extensions is not None
            else ([".pa"] if path_no == 0 else [f".p{effective_path}".lower(), f".p-{effective_path}".lower()])
        )
        fallback_entry = None
        multipath_fallback = None
        for file_path in self._iter_storage_files(storage_dir):
            if not self._is_candidate_program_file(file_path):
                continue
            program_entry = self._parse_program_file(file_path)
            if program_entry and program_entry["number"] == prog_num:
                suffix = file_path.suffix.lower()
                if suffix in preferred_extensions or (path_no == 0 and (suffix == ".pa" or program_entry.get("is_multipath"))):
                    return program_entry
                if path_no == 0 and program_entry.get("is_multipath") and multipath_fallback is None:
                    multipath_fallback = program_entry
                if configured_extensions is None and fallback_entry is None:
                    fallback_entry = program_entry
        return multipath_fallback or fallback_entry

    @staticmethod
    def _normalize_extensions(file_extensions: Optional[List[str]]) -> Optional[set[str]]:
        if file_extensions is None:
            return None
        return {f".{extension.lstrip('.').lower()}" if extension else "" for extension in file_extensions}

    def _parse_program_file(self, file_path: Path) -> Optional[Dict[str, Any]]:
        try:
            stat = file_path.stat()
            if stat.st_size == 0 or stat.st_size > MAX_PROGRAM_FILE_BYTES:
                return None
            try:
                program_text = file_path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                program_text = file_path.read_text(encoding="latin-1")
        except OSError:
            return None

        if "\x00" in program_text:
            return None

        normalized = self._normalize_program_text(program_text)
        number = self._extract_program_number(normalized)
        if number is None:
            match = FILE_NUMBER_RE.search(file_path.stem)
            if not match:
                return None
            number = int(match.group(1))

        channels = self._extract_multipath_channels(normalized)
        is_multipath = len(channels) > 1 or (len(channels) == 1 and file_path.suffix.lower() == ".pa")

        return {
            "number": number,
            "comment": self._extract_comment(normalized, file_path.stem),
            "program_text": normalized,
            "file_path": file_path,
            "is_multipath": is_multipath,
            "channels": channels,
        }

    @staticmethod
    def _extract_multipath_channels(program_text: str) -> List[int]:
        seen: List[int] = []
        for match in PA_SECTION_RE.finditer(program_text):
            ch = int(match.group(1))
            if ch > 0 and ch not in seen:
                seen.append(ch)
        return sorted(seen)

    @staticmethod
    def _normalize_program_text(program_text: str) -> str:
        normalized = program_text.replace("\r\n", "\n").replace("\r", "\n").strip()
        if PA_SECTION_RE.search(normalized):
            normalized = UsbTransferClient._normalize_pa_program_text(normalized)
        else:
            if not normalized.startswith("%"):
                normalized = f"%\n{normalized}"
            if not normalized.rstrip().endswith("%"):
                normalized = f"{normalized.rstrip()}\n%"
        return normalized + ("\n" if not normalized.endswith("\n") else "")

    @staticmethod
    def _normalize_pa_program_text(program_text: str) -> str:
        matches = list(PA_SECTION_RE.finditer(program_text))
        if not matches:
            return program_text

        sections: List[Dict[str, Any]] = []
        for idx, match in enumerate(matches):
            end_idx = matches[idx + 1].start() if idx + 1 < len(matches) else len(program_text)
            raw_tag = match.group(0)
            path_num = int(match.group(1))
            tag_prog_match = PA_MARKER_PROGRAM_RE.search(raw_tag)
            prog_name = f"O{int(tag_prog_match.group(1)):04d}" if tag_prog_match else ""
            body = program_text[match.end():end_idx]
            if body.replace("%", "").strip():
                sections.append({"path": path_num, "prog_name": prog_name, "body": body})

        if not sections:
            return program_text

        prog_number = UsbTransferClient._extract_program_number(program_text)
        formatted_prog = f"O{prog_number:04d}" if prog_number is not None else (sections[0]["prog_name"] or "O0001")

        formatted_blocks: List[str] = []
        for section in sections:
            clean_body = section["body"].strip()
            while clean_body.startswith("%"):
                clean_body = clean_body[1:].lstrip()
            while clean_body.endswith("%"):
                clean_body = clean_body[:-1].rstrip()

            lines = clean_body.split("\n")
            if lines:
                first_line = lines[0].strip()
                header_match = re.match(r"^O\d+\s*(.*)$", first_line, re.IGNORECASE)
                if header_match:
                    remainder = header_match.group(1).strip()
                    if remainder:
                        lines[0] = remainder
                    else:
                        lines.pop(0)
                    clean_body = "\n".join(lines).strip()

            formatted_blocks.append(f"<{formatted_prog}.P{section['path']}>\n{clean_body}")

        return f"%\n&F=/{formatted_prog}/\n" + "\n".join(formatted_blocks) + "\n%"

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