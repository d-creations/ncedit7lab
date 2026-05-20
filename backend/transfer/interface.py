from typing import Dict, Any, List, Optional

class TransferError(Exception):
    """Base class for transfer-related errors."""
    def __init__(self, code: int, message: str, reason: str = "Unknown"):
        self.code = code
        self.reason = reason
        self.message = f"{message} (Code: {code} - {reason})"
        super().__init__(self.message)

class ProtocolClient:
    """Abstract base class for all NC transfer protocols."""
    def connect(self, ip: str, port: Optional[int] = None, timeout: int = 10, **kwargs) -> bool:
        raise NotImplementedError
        
    def disconnect(self):
        raise NotImplementedError
        
    def set_path(self, path_no: int):
        raise NotImplementedError
        
    def delete_program(self, prog_num: int, path_no: int = 0):
        raise NotImplementedError
        
    def download_program(self, program_text: str, path_no: int = 0):
        raise NotImplementedError
        
    def upload_program(self, prog_num: int, path_no: int = 0) -> str:
        raise NotImplementedError
        
    def list_programs(self, path_no: int = 0) -> list:
        raise NotImplementedError
