from pathlib import Path
import re
from typing import Any, Dict, List, Optional

from .interface import ProtocolClient, TransferError

USB_ERROR = 1
PROGRAM_NUMBER_RE = re.compile(r"(?:^|\n)\s*O(\d+)\b", re.IGNORECASE)
COMMENT_RE = re.compile(r"\(([^)]*)\)")
FILE_NUMBER_RE = re.compile(r"O(\d+)", re.IGNORECASE)
PATH_DIR_CANDIDATES = {
    1: ("PATH1", "P1", "CH1"),
    2: ("PATH2", "P2", "CH2"),
    3: ("PATH3", "P3", "CH3"),
}
ALLOWED_SUFFIXES = {"", ".mpf", ".spf", ".nc", ".txt", ".p1", ".p2", ".p3", ".pa", ".eia", ".min"}


class UsbTransferClient(ProtocolClient):
    def __init__(self):
        self.root_path: Optional[Path] = None

    def connect(self, ip: str, port: Optional[int] = None, timeout: int = 10, **kwargs) -> bool:
        if not ip or ip.strip() == "" or ip == "DEMO":
             raise TransferError(USB_ERROR, "Please enter or select a valid local folder path.", "invalid path")
             
        root_path = Path(ip).expanduser()
        if not root_path.exists() or not root_path.is_dir():
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
        program_entry = self._find_program_entry(storage_dir, prog_num)
        if not program_entry:
            raise TransferError(USB_ERROR, f"Program O{prog_num} not found on USB path {path_no or 1}", "not found")
        program_entry["file_path"].unlink()

    def download_program(self, program_text: str, path_no: int = 0):
        storage_dir = self._get_storage_dir(path_no or 1, create=True)
        normalized = self._normalize_program_text(program_text)
        program_number = self._extract_program_number(normalized)
        if program_number is None:
            raise TransferError(USB_ERROR, "USB upload requires an O-number in the program header", "missing program number")

        target_file = storage_dir / f"O{program_number:04d}.P{path_no or 1}"
        target_file.write_text(normalized, encoding="utf-8", newline="\n")

    def upload_program(self, prog_num: int, path_no: int = 0) -> str:
        storage_dir = self._get_storage_dir(path_no or 1)
        program_entry = self._find_program_entry(storage_dir, prog_num)
        if not program_entry:
            raise TransferError(USB_ERROR, f"Program O{prog_num} not found on USB path {path_no or 1}", "not found")
        return program_entry["program_text"]

    def list_programs(self, path_no: int = 0) -> list:
        storage_dir = self._get_storage_dir(path_no or 1, allow_missing=True)
        if storage_dir is None:
            return []

        programs: List[Dict[str, Any]] = []
        for file_path in sorted(storage_dir.iterdir()):
            if not file_path.is_file() or file_path.suffix.lower() not in ALLOWED_SUFFIXES:
                continue

            program_entry = self._parse_program_file(file_path)
            if program_entry is None:
                continue

            programs.append({
                "number": program_entry["number"],
                "length": len(program_entry["program_text"].encode("utf-8")),
                "comment": program_entry["comment"],
            })

        return sorted(programs, key=lambda item: item["number"])

    def _get_storage_dir(self, path_no: int, create: bool = False, allow_missing: bool = False) -> Optional[Path]:
        root_path = self._require_root_path()
        normalized_path_no = path_no or 1

        for candidate_name in PATH_DIR_CANDIDATES.get(normalized_path_no, ()): 
            candidate = root_path / candidate_name
            if candidate.exists() and candidate.is_dir():
                return candidate

        if normalized_path_no == 1:
            return root_path

        if allow_missing:
            return None

        target_dir = root_path / f"PATH{normalized_path_no}"
        if create:
            target_dir.mkdir(parents=True, exist_ok=True)
            return target_dir

        if target_dir.exists() and target_dir.is_dir():
            return target_dir

        raise TransferError(USB_ERROR, f"USB path folder PATH{normalized_path_no} does not exist", "missing path directory")

    def _require_root_path(self) -> Path:
        if self.root_path is None:
            raise TransferError(USB_ERROR, "USB storage is not connected", "not connected")
        return self.root_path

    def _find_program_entry(self, storage_dir: Path, prog_num: int) -> Optional[Dict[str, Any]]:
        for file_path in sorted(storage_dir.iterdir()):
            if not file_path.is_file() or file_path.suffix.lower() not in ALLOWED_SUFFIXES:
                continue
            program_entry = self._parse_program_file(file_path)
            if program_entry and program_entry["number"] == prog_num:
                return program_entry
        return None

    def _parse_program_file(self, file_path: Path) -> Optional[Dict[str, Any]]:
        try:
            program_text = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            program_text = file_path.read_text(encoding="latin-1")

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
            return None
        return int(match.group(1))

    @staticmethod
    def _extract_comment(program_text: str, fallback: str) -> str:
        match = COMMENT_RE.search(program_text)
        return match.group(1).strip() if match else fallback