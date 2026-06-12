from .interface import ProtocolClient, TransferError
from .focas import get_focas_client, get_demo_focas_client, is_demo_ip, RealFocasClient
from .usb import UsbTransferClient

def get_transfer_client(protocol: str, dll_path: str = None) -> ProtocolClient:
    """Factory to get the appropriate transfer client based on protocol."""
    # For now, we only have FOCAS implemented
    if protocol.lower() == "focas":
        # If a custom DLL path is provided, we might want to instantiate a new client
        # In a real app we might cache these per dll_path, but for now reuse global
        # if no path provided or fallback to a new instance.
        if dll_path:
            # Recreate or cache based on dll_path
            from .focas import USE_MOCK, DummyFocasClient
            if USE_MOCK:
                return DummyFocasClient()
            return RealFocasClient(dll_path=dll_path)
            
        return get_focas_client()

    if protocol.lower() == "usb":
        return UsbTransferClient()
    
    raise ValueError(f"Unsupported transfer protocol: {protocol}")
