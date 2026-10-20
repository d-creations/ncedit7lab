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

    assert programs == [{
        "number": 1234,
        "length": len("%\nO1234\n(ROOT DEMO)\nM30\n%\n".encode("utf-8")),
        "comment": "ROOT DEMO",
        "file_extension": ".P1",
    }]


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


def test_usb_transfer_filters_and_pulls_main_and_sub_extensions(tmp_path):
    root = tmp_path / "usb"
    root.mkdir()
    (root / "O1234.M").write_text("O1234\n(MAIN)\nM30\n", encoding="utf-8")
    (root / "O1234.S").write_text("O1234\n(SUB)\nM99\n", encoding="utf-8")

    client = UsbTransferClient()
    assert client.connect(str(root)) is True

    assert client.list_programs(1, [".M"])[0]["comment"] == "MAIN"
    assert client.list_programs(2, [".S"])[0]["comment"] == "SUB"
    assert client.list_programs(1, [".M"])[0]["file_extension"] == ".M"
    assert client.list_programs(2, [".S"])[0]["file_extension"] == ".S"
    assert "(MAIN)" in client.upload_program(1234, 1, [".M"])
    assert "(SUB)" in client.upload_program(1234, 2, [".S"])

    client.download_program("O2001\n(NEW MAIN)\nM30", 1, ".M")
    client.download_program("O2002\n(NEW SUB)\nM99", 2, ".S")
    assert (root / "O2001.M").exists()
    assert (root / "O2002.S").exists()


def test_usb_transfer_downloads_pa_container_as_single_file(tmp_path):
    root = tmp_path / "usb"
    root.mkdir()
    pa_content = "%\n&F=/O1000/\n<O1000.P1>\n(WERKSTUCK)\nM99\n<O1000.P2>\nG0G40G80\nM99\n<O1000.P3>\nG28U0.\nM99\n%"

    client = UsbTransferClient()

    assert client.connect(str(root)) is True
    client.download_program(pa_content, 0)

    stored = root / "O1000.PA"
    assert stored.exists()
    stored_content = stored.read_text(encoding="utf-8")
    assert "<O1000.P1>" in stored_content
    assert "<O1000.P2>" in stored_content
    assert "<O1000.P3>" in stored_content


def test_usb_transfer_rejects_missing_root(tmp_path):
    client = UsbTransferClient()

    with pytest.raises(TransferError, match="does not exist or is not a directory"):
        client.connect(str(tmp_path / "missing"))


def test_usb_transfer_normalizes_drive_only_path():
    normalized = UsbTransferClient._normalize_usb_path("D:")
    assert str(normalized) in ("D:\\", "D:/")


def test_usb_transfer_skips_unreadable_entries(tmp_path, monkeypatch):
    root = tmp_path / "usb"
    root.mkdir()
    good_file = root / "O1234.P1"
    bad_file = root / "O9999.P1"
    good_file.write_text("O1234\n(GOOD)\nM30\n", encoding="utf-8")
    bad_file.write_text("O9999\n(LOCKED)\nM30\n", encoding="utf-8")

    original_read_text = type(good_file).read_text

    def patched_read_text(self, *args, **kwargs):
        if self.name == "O9999.P1":
            raise PermissionError("Access is denied")
        return original_read_text(self, *args, **kwargs)

    monkeypatch.setattr(type(good_file), "read_text", patched_read_text)

    client = UsbTransferClient()
    assert client.connect(str(root)) is True
    programs = client.list_programs(1)
    assert [p["number"] for p in programs] == [1234]
