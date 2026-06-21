import pytest

from backend.transfer.interface import TransferError
from backend.transfer.usb import UsbTransferClient


def test_usb_transfer_lists_programs_from_root_for_path_1(tmp_path):
    root = tmp_path / "usb"
    root.mkdir()
    (root / "O1234.P1").write_text("%\nO1234\n(ROOT DEMO)\nM30\n%\n", encoding="utf-8")

    client = UsbTransferClient()

    assert client.connect(str(root)) is True
    programs = client.list_programs(1)

    assert programs == [{"number": 1234, "length": len("%\nO1234\n(ROOT DEMO)\nM30\n%\n".encode("utf-8")), "comment": "ROOT DEMO"}]


def test_usb_transfer_uses_path_subdirectories_when_present(tmp_path):
    root = tmp_path / "usb"
    root.mkdir()
    (root / "O2001.P2").write_text("O2001\n(PATH TWO)\nM30\n", encoding="utf-8")

    client = UsbTransferClient()

    assert client.connect(str(root)) is True
    programs = client.list_programs(2)

    assert len(programs) == 1
    assert programs[0]["number"] == 2001
    assert programs[0]["comment"] == "PATH TWO"


def test_usb_transfer_lists_root_and_path_1_subdirectory(tmp_path):
    root = tmp_path / "usb"
    root.mkdir(parents=True)
    (root / "O1001.P1").write_text("O1001\n(ROOT PROGRAM)\nM30\n", encoding="utf-8")
    (root / "O1002.P1").write_text("O1002\n(PATH ONE PROGRAM)\nM30\n", encoding="utf-8")

    client = UsbTransferClient()

    assert client.connect(str(root)) is True
    programs = client.list_programs(1)

    assert [program["number"] for program in programs] == [1001, 1002]


def test_usb_transfer_download_and_upload_round_trip(tmp_path):
    root = tmp_path / "usb"
    root.mkdir()

    client = UsbTransferClient()

    assert client.connect(str(root)) is True
    client.download_program("O4567\n(SAVED TO USB)\nM30", 1)

    stored = root / "O4567.P1"
    assert stored.exists()
    uploaded = client.upload_program(4567, 1)

    assert "O4567" in uploaded
    assert "(SAVED TO USB)" in uploaded


def test_usb_transfer_rejects_missing_root(tmp_path):
    client = UsbTransferClient()

    with pytest.raises(TransferError, match="does not exist or is not a directory"):
        client.connect(str(tmp_path / "missing"))