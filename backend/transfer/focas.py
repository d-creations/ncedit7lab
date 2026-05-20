import ctypes
import os
import re
import time
import logging
from copy import deepcopy
from threading import Lock
from typing import Optional, Tuple, Dict, Any

from .interface import ProtocolClient, TransferError

logger = logging.getLogger(__name__)

# FOCAS Error Codes (from Fwlib64.h)
EW_OK = 0
EW_PROTOCOL = -1
EW_RESET = -2
EW_HANDLE = -8
EW_NODLL = -15
EW_SOCKET = -16
EW_DATA = 5
EW_PROT = 7
EW_OVRFLOW = 8
EW_BUFFER = 10
EW_REJECT = 13
EW_ALARM = 15

# Additional error definitions
ERROR_MESSAGES = {
    0: "Success (EW_OK)",
    -1: "Protocol error (EW_PROTOCOL)",
    -2: "CNC reset/stop (EW_RESET)",
    -8: "Socket timeout (EW_SOCKET)",
    -15: "DLL not loaded or not found (EW_NODLL)",
    -16: "Socket communication error. Connection closed by CNC or network failure (EW_SOCKET)",
    1: "CNC is busy (EW_BUSY)",
    5: "Data error / Program already exists (EW_DATA)",
    7: "Write protected on CNC (EW_PROT)",
    8: "Memory overflow on CNC (EW_OVRFLOW)",
    10: "Buffer empty/full (EW_BUFFER)",
    13: "Execution rejected by CNC (EW_REJECT)",
    15: "Alarm state on CNC (EW_ALARM)",
}

class FocasError(TransferError):
    def __init__(self, code: int, message: str):
        reason = ERROR_MESSAGES.get(code, "Unknown Error")
        super().__init__(code=code, message=message, reason=reason)

class FOCAS_DATE(ctypes.Structure):
    """Date structure for FOCAS directory listings"""
    _fields_ = [
        ("year", ctypes.c_short),
        ("month", ctypes.c_short),
        ("day", ctypes.c_short),
        ("hour", ctypes.c_short),
        ("minute", ctypes.c_short),
        ("dummy", ctypes.c_short)
    ]

class PRGDIR3(ctypes.Structure):
    """C-Structure for cnc_rdprogdir3"""
    _fields_ = [
        ("number", ctypes.c_long),
        ("length", ctypes.c_long),
        ("page", ctypes.c_long),
        ("comment", ctypes.c_char * 52),
        ("mdate", FOCAS_DATE),
        ("cdate", FOCAS_DATE)
    ]

class DummyFocasClient(ProtocolClient):
    """Dummy FOCAS client for testing without a CNC or DLLs."""
    def __init__(self):
        self.connected = False
        self._lock = Lock()
        self._programs_by_path = self._build_seed_programs()

    @staticmethod
    def _make_program(number: int, comment: str, body: str) -> Dict[str, Any]:
        program_text = body.strip()
        if not program_text.startswith("%"):
            program_text = f"%\n{program_text}"
        if not program_text.rstrip().endswith("%"):
            program_text = f"{program_text.rstrip()}\n%"
        return {
            "number": number,
            "comment": comment,
            "program_text": program_text,
        }

    @classmethod
    def _build_seed_programs(cls) -> Dict[int, Dict[int, Dict[str, Any]]]:
        return {
            1: {
                1000: cls._make_program(1000, "PA MAIN SPINDLE", """
O1000
(DEMO PA MAIN - PATH 1)
G21
G17 G40 G80
G0 X0. Y0. Z20.
G1 Z-3. F180.
X20. Y0.
Y20.
X0.
Y0.
G0 Z20.
M30
"""),
                1101: cls._make_program(1101, "FRONT OP ROUGH", """
O1101
(DEMO FRONT OP - PATH 1)
T0101
G97 S1800 M3
G0 X32. Z4.
G1 Z0. F0.2
X18.
Z-24.
G0 X80. Z80.
M30
"""),
                1201: cls._make_program(1201, "MILL SLOT", """
O1201
(DEMO MILL SLOT - PATH 1)
G90 G54
G0 X-12. Y0. Z10.
G1 Z-2.5 F120.
X12.
G0 Z10.
M30
"""),
            },
            2: {
                1000: cls._make_program(1000, "PA MAIN SPINDLE", """
O1000
(DEMO PA MAIN - PATH 2)
G21
G17 G40 G80
G0 X0. Y0. Z18.
G1 Z-2. F200.
X15. Y15.
X30. Y0.
G0 Z18.
M30
"""),
                2100: cls._make_program(2100, "SUB SPINDLE PICKOFF", """
O2100
(DEMO SUB SPINDLE - PATH 2)
G50 S4000
G97 S2200 M3
G0 X24. Z2.
G1 Z-12. F0.18
X12.
G0 X80. Z80.
M30
"""),
                2205: cls._make_program(2205, "BACK WORK", """
O2205
(DEMO BACK WORK - PATH 2)
G0 X0. Y0. Z12.
G1 Z-1.5 F90.
X8. Y-8.
X16. Y0.
G0 Z12.
M30
"""),
            },
            3: {
                3007: cls._make_program(3007, "GANG DRILL", """
O3007
(DEMO GANG TOOL - PATH 3)
G90 G54
G0 X0. Y0. Z15.
G81 X0. Y0. Z-8. R2. F100.
X18. Y0.
X18. Y18.
G80
G0 Z15.
M30
"""),
                3010: cls._make_program(3010, "THREAD MILL", """
O3010
(DEMO THREAD MILL - PATH 3)
G90 G54
G0 X6. Y0. Z8.
G3 I-6. Z-6. F80.
G0 Z8.
M30
"""),
            },
        }

    @staticmethod
    def _normalize_program_text(program_text: str) -> str:
        normalized = (program_text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
        if not normalized.startswith("%"):
            normalized = f"%\n{normalized.lstrip()}"
        if not normalized.rstrip().endswith("%"):
            normalized = f"{normalized.rstrip()}\n%"
        return normalized

    @staticmethod
    def _extract_program_number(program_text: str) -> Optional[int]:
        match = re.search(r"(?:^|\n)O(\d+)(?:\b|\s)", program_text, flags=re.IGNORECASE)
        if not match:
            return None
        return int(match.group(1))

    @staticmethod
    def _extract_comment(program_text: str, fallback: str) -> str:
        match = re.search(r"\(([^\n\r()]*)\)", program_text)
        if match:
            comment = match.group(1).strip()
            if comment:
                return comment[:48]
        return fallback
        
    def connect(self, ip: str, port: Optional[int] = 8193, timeout: int = 10) -> bool:
        if port is None:
            port = 8193
        logger.info(f"[DUMMY] Connecting to {ip}:{port}")
        self.connected = True
        return True
        
    def disconnect(self):
        logger.info("[DUMMY] Disconnected")
        self.connected = False
        
    def set_path(self, path_no: int):
        logger.info(f"[DUMMY] Path set to {path_no}")
        
    def delete_program(self, prog_num: int, path_no: int = 0):
        target_path = path_no or 1
        logger.info(f"[DUMMY] Deleting O{prog_num} from Path {target_path}")
        with self._lock:
            if target_path in self._programs_by_path and prog_num in self._programs_by_path[target_path]:
                del self._programs_by_path[target_path][prog_num]

    def download_program(self, program_text: str, path_no: int = 0):
        target_path = path_no or 1
        logger.info(f"[DUMMY] Downloading {len(program_text)} bytes to Path {target_path}")
        normalized = self._normalize_program_text(program_text)
        program_number = self._extract_program_number(normalized)
        if program_number is None:
            raise FocasError(EW_DATA, "Demo upload requires an O-number in the program header")

        with self._lock:
            path_programs = self._programs_by_path.setdefault(target_path, {})
            existing = path_programs.get(program_number)
            fallback_comment = existing["comment"] if existing else f"DEMO PATH {target_path}"
            path_programs[program_number] = {
                "number": program_number,
                "comment": self._extract_comment(normalized, fallback_comment),
                "program_text": normalized,
            }

        time.sleep(0.1)
        
    def upload_program(self, prog_num: int, path_no: int = 0) -> str:
        target_path = path_no or 1
        logger.info(f"[DUMMY] Uploading O{prog_num} from Path {target_path}")
        with self._lock:
            program = self._programs_by_path.get(target_path, {}).get(prog_num)
            if not program:
                raise FocasError(EW_DATA, f"Program O{prog_num} not found on demo path {target_path}")
            program_text = program["program_text"]
        time.sleep(0.1)
        return program_text

    def list_programs(self, path_no: int = 0) -> list:
        target_path = path_no or 1
        logger.info(f"[DUMMY] Listing programs for Path {target_path}")
        with self._lock:
            programs = list(self._programs_by_path.get(target_path, {}).values())
            return [
                {
                    "number": program["number"],
                    "length": len(program["program_text"].encode("ascii", errors="ignore")),
                    "comment": program["comment"],
                }
                for program in sorted(programs, key=lambda item: item["number"])
            ]

    def reset_demo_state(self):
        with self._lock:
            self._programs_by_path = deepcopy(self._build_seed_programs())

class RealFocasClient(ProtocolClient):
    def __init__(self, dll_path: str = "focas_dlls/FWLIB64.DLL"):
        self.lib = None
        self.handle = ctypes.c_ushort(0)
        
        # Resolve absolute path relative to this file's dir
        base_dir = os.path.dirname(os.path.abspath(__file__))
        dll_dir = os.path.dirname(os.path.join(base_dir, dll_path))
        abs_dll_path = os.path.join(base_dir, dll_path)
        
        # In Python 3.8+ on Windows, DLL resolution requires explicitly adding the directory
        if hasattr(os, 'add_dll_directory') and os.name == 'nt':
            try:
                os.add_dll_directory(dll_dir)
            except Exception as e:
                logger.warning(f"Could not add DLL directory {dll_dir}: {e}")

        try:
            # Try to load the 64-bit library
            self.lib = ctypes.cdll.LoadLibrary(abs_dll_path)
            self._setup_prototypes()
            logger.info(f"Successfully loaded FOCAS library: {abs_dll_path}")
        except OSError as e:
            logger.error(f"Could not load FOCAS library {abs_dll_path}. Ensure it is inside backend/focas_dlls: {e}")

    def _setup_prototypes(self):
        """Define argument types and return types for safety."""
        if not self.lib:
            return
            
        # Connect & Disconnect
        self.lib.cnc_allclibhndl3.argtypes = [ctypes.c_char_p, ctypes.c_ushort, ctypes.c_long, ctypes.POINTER(ctypes.c_ushort)]
        self.lib.cnc_allclibhndl3.restype = ctypes.c_short
        
        self.lib.cnc_freelibhndl.argtypes = [ctypes.c_ushort]
        self.lib.cnc_freelibhndl.restype = ctypes.c_short

        # Multi-channel Path operations
        self.lib.cnc_setpath.argtypes = [ctypes.c_ushort, ctypes.c_short]
        self.lib.cnc_setpath.restype = ctypes.c_short
        
        self.lib.cnc_getpath.argtypes = [ctypes.c_ushort, ctypes.POINTER(ctypes.c_short), ctypes.POINTER(ctypes.c_short)]
        self.lib.cnc_getpath.restype = ctypes.c_short

        # Download (PC -> CNC)
        self.lib.cnc_dwnstart3.argtypes = [ctypes.c_ushort, ctypes.c_short]
        self.lib.cnc_dwnstart3.restype = ctypes.c_short
        
        self.lib.cnc_download3.argtypes = [ctypes.c_ushort, ctypes.POINTER(ctypes.c_long), ctypes.c_char_p]
        self.lib.cnc_download3.restype = ctypes.c_short
        
        self.lib.cnc_dwnend3.argtypes = [ctypes.c_ushort]
        self.lib.cnc_dwnend3.restype = ctypes.c_short

        # Upload (CNC -> PC)
        self.lib.cnc_upstart3.argtypes = [ctypes.c_ushort, ctypes.c_short, ctypes.c_long, ctypes.c_long]
        # Directory / Read Programs
        self.lib.cnc_rdprogdir3.argtypes = [ctypes.c_ushort, ctypes.c_short, ctypes.POINTER(ctypes.c_long), ctypes.POINTER(ctypes.c_short), ctypes.c_void_p]
        self.lib.cnc_rdprogdir3.restype = ctypes.c_short

        self.lib.cnc_upstart3.restype = ctypes.c_short
        
        self.lib.cnc_upload3.argtypes = [ctypes.c_ushort, ctypes.POINTER(ctypes.c_long), ctypes.c_char_p]
        self.lib.cnc_upload3.restype = ctypes.c_short
        
        self.lib.cnc_upend3.argtypes = [ctypes.c_ushort]
        self.lib.cnc_upend3.restype = ctypes.c_short

        self.lib.cnc_delete.argtypes = [ctypes.c_ushort, ctypes.c_short]
        self.lib.cnc_delete.restype = ctypes.c_short

    def connect(self, ip: str, port: Optional[int] = 8193, timeout: int = 10) -> bool:
        if port is None:
            port = 8193
        if not self.lib:
            raise RuntimeError("FOCAS Library not loaded")
            
        ip_encoded = ip.encode('ascii')
        
        # Free previous handle if it exists before trying to allocate a new one
        if self.handle.value != 0:
            self.disconnect()

        # FWLIB64 dynamically loads fwlibe64.dll and other dependencies without absolute paths during cnc_allclibhndl3.
        # We must temporarily change the process working directory so Windows can find them.
        old_cwd = os.getcwd()
        focas_dir = os.path.dirname(os.path.abspath(self.lib._name))
        
        try:
            os.chdir(focas_dir)
            ret = self.lib.cnc_allclibhndl3(ip_encoded, port, timeout, ctypes.byref(self.handle))
        finally:
            os.chdir(old_cwd)

        if ret != EW_OK:
            logger.error(f"FOCAS Connection Error to {ip}:{port}. Code: {ret}")
            return False
        return True

    def disconnect(self):
        if self.lib and self.handle.value != 0:
            self.lib.cnc_freelibhndl(self.handle)
            self.handle.value = 0

    def set_path(self, path_no: int):
        if path_no == 0:
            return  # Default
            
        ret = self.lib.cnc_setpath(self.handle, path_no)
        if ret != EW_OK:
            raise FocasError(ret, f"Failed to set FOCAS path to {path_no}")

    def delete_program(self, prog_num: int, path_no: int = 0):
        self.set_path(path_no)
        # Attempt to delete the program, ignore if it doesn't exist to allow safe overwrite
        ret = self.lib.cnc_delete(self.handle, prog_num)
        if ret != EW_OK and ret != EW_DATA: 
            logger.warning(f"cnc_delete returned code {ret} for O{prog_num}. Program might not exist or could be protected.")

    def download_program(self, program_text: str, path_no: int = 0):
        self.set_path(path_no)
        
        if not program_text.startswith("\n"): program_text = "\n" + program_text
        if not program_text.strip().endswith("%"): program_text = program_text.rstrip() + "\n%"
            
        raw_data = program_text.encode('ascii', errors='ignore')
        
        # Try to parse program number from text to explicitly delete before upload
        prog_match = re.search(r"O(\d+)", program_text, flags=re.IGNORECASE)
        if prog_match:
            try:
                self.delete_program(int(prog_match.group(1)), path_no)
            except Exception as e:
                logger.warning(f"Fail to delete O{prog_match.group(1)} beforehand: {e}")

        ret = self.lib.cnc_dwnstart3(self.handle, 0)
        if ret != EW_OK: raise FocasError(ret, "Failed to start download sequence (cnc_dwnstart3). It might already exist or memory is full.")

        try:
            while len(raw_data) > 0:
                chunk_len = ctypes.c_long(len(raw_data))
                ret = self.lib.cnc_download3(self.handle, ctypes.byref(chunk_len), raw_data)
                
                if ret == EW_BUFFER:
                    time.sleep(0.1)
                    continue
                elif ret == EW_OK:
                    raw_data = raw_data[chunk_len.value:]
                else:
                    raise FocasError(ret, f"Error during data transfer loop (cnc_download3)")
        finally:
            end_ret = self.lib.cnc_dwnend3(self.handle)
            if end_ret != EW_OK: logger.warning(f"cnc_dwnend3 returned non-zero during cleanup: {end_ret}")

    def upload_program(self, prog_num: int, path_no: int = 0) -> str:
        self.set_path(path_no)
        
        ret = self.lib.cnc_upstart3(self.handle, 0, prog_num, prog_num)
        if ret != EW_OK: raise FocasError(ret, f"Failed to start upload for program O{prog_num}")
            
        buf_size = 1280
        buffer = ctypes.create_string_buffer(buf_size + 1)
        result_text = []
        
        try:
            while True:
                length = ctypes.c_long(buf_size)
                ret = self.lib.cnc_upload3(self.handle, ctypes.byref(length), buffer)
                
                if ret == EW_BUFFER:
                    time.sleep(0.05)
                    continue
                    
                if ret == EW_OK:
                    chunk_str = buffer.raw[:length.value].decode('ascii', errors='ignore')
                    result_text.append(chunk_str)
                    combined_text = "".join(result_text).rstrip("\r\n ")
                    if combined_text.count("%") >= 2 and combined_text.endswith("%"):
                        break
                elif ret == EW_RESET:
                    break
                else:
                    raise FocasError(ret, "Error during data receive loop (cnc_upload3)")
        finally:
            end_ret = self.lib.cnc_upend3(self.handle)
            if end_ret != EW_OK: logger.warning(f"cnc_upend3 returned non-zero during cleanup: {end_ret}")
        return "".join(result_text)

    def list_programs(self, path_no: int = 0) -> list:
        self.set_path(path_no)
        
        MAX_PROG = 10
        prgdir_array = (PRGDIR3 * MAX_PROG)()
        top_prog = ctypes.c_long(0)
        
        programs = []
        
        while True:
            num_prog = ctypes.c_short(MAX_PROG)
            # type 2 = read prog number, length, comment, and date
            ret = self.lib.cnc_rdprogdir3(self.handle, 2, ctypes.byref(top_prog), ctypes.byref(num_prog), ctypes.byref(prgdir_array))
            
            if ret == EW_OK:
                for i in range(num_prog.value):
                    prog = prgdir_array[i]
                    comment = prog.comment.decode('ascii', errors='ignore').strip('\x00').strip()
                    programs.append({
                        "number": prog.number,
                        "length": prog.length,
                        "comment": comment
                    })
                
                if num_prog.value < MAX_PROG:
                    break  # Read all programs
                else:
                    # Set up to read the next batch
                    top_prog.value = prgdir_array[MAX_PROG - 1].number + 1
            else:
                # EW_DATA (no program found), or other error stops the loop
                break
                
        return programs

# Dependency Injection setup
USE_MOCK = os.environ.get("USE_MOCK_FOCAS", "0") == "1"

# Initialize a global instance based on environment variable
# You can set USE_MOCK_FOCAS=1 in your environment/docker-compose to use the mock DLLs.
_focas_instance = DummyFocasClient() if USE_MOCK else RealFocasClient()

def get_focas_client() -> ProtocolClient:
    """FastAPI Dependency for FOCAS operations"""
    return _focas_instance


_demo_focas_instance = DummyFocasClient()


def is_demo_ip(ip_address: str) -> bool:
    return ip_address.strip().upper() == "DEMO"


def get_demo_focas_client() -> ProtocolClient:
    return _demo_focas_instance
