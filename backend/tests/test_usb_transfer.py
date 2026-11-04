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
    assert stored_content == (
        "%\n"
        "&F=/O1000/\n"
        "<O1000.P1>\n"
        "(WERKSTUCK)\n"
        "M99\n"
        "<O1000.P2>\n"
        "G0G40G80\n"
        "M99\n"
        "<O1000.P3>\n"
        "G28U0.\n"
        "M99\n"
        "%\n"
    )


def test_usb_transfer_formats_pa_container_whether_percent_or_header_present_or_not(tmp_path):
    root = tmp_path / "usb"
    root.mkdir()
    # Missing %, missing &F=/O1612/, inner O1612 lines and % inside channels
    raw_pa = (
        "<O1612.P1>\n"
        "%\n"
        "O1612\n"
        "(SCP TRAINING SUS304 D=20.0)\n"
        "(PATH 1)\n"
        "M99P99\n"
        "%\n\n"
        "<O1612.P2>\n"
        "%\n"
        "O1612\n"
        "(SCP TRAINING SUS304 D=20.0)\n"
        "G130\n"
        "M99P99\n"
        "%"
    )

    client = UsbTransferClient()
    assert client.connect(str(root)) is True
    client.download_program(raw_pa, 0, ".PA")

    stored = root / "O1612.PA"
    assert stored.exists()
    stored_content = stored.read_text(encoding="utf-8")
    assert stored_content == (
        "%\n"
        "&F=/O1612/\n"
        "<O1612.P1>\n"
        "(SCP TRAINING SUS304 D=20.0)\n"
        "(PATH 1)\n"
        "M99P99\n"
        "<O1612.P2>\n"
        "(SCP TRAINING SUS304 D=20.0)\n"
        "G130\n"
        "M99P99\n"
        "%\n"
    )


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


def test_usb_transfer_lists_all_extensions_no_extension_and_multipath_containers(tmp_path):
    root = tmp_path / "usb"
    root.mkdir()
    # Multipath .PA container with P1..P4
    (root / "O1000.PA").write_text(
        "%\n&F=/O1000/\n<O1000.P1>\n(MULTI PA)\nM99\n<O1000.P2>\nG0 X0\nM99\n<O1000.P3>\nG0 Z0\nM99\n<O1000.P4>\nM30\n%\n",
        encoding="utf-8",
    )
    # Split P1..P4 files
    (root / "O2000.P1").write_text("O2000\n(P1 PART)\nM30\n", encoding="utf-8")
    (root / "O2000.P2").write_text("O2000\n(P2 PART)\nM30\n", encoding="utf-8")
    (root / "O2000.P4").write_text("O2000\n(P4 PART)\nM30\n", encoding="utf-8")
    # .M and .S files with same O-number
    (root / "O3000.M").write_text("O3000\n(MAIN M)\nM30\n", encoding="utf-8")
    (root / "O3000.S").write_text("O3000\n(SUB S)\nM99\n", encoding="utf-8")
    # File without extension and file with custom extension
    (root / "O4000").write_text("O4000\n(NO EXT)\nM30\n", encoding="utf-8")
    (root / "O5000.PRG").write_text("O5000\n(CUSTOM EXT)\nM30\n", encoding="utf-8")
    # Multipath file with no extension
    (root / "O6000").write_text("<O6000.P1>\n(NO EXT MULTI)\nM30\n<O6000.P2>\nM30\n", encoding="utf-8")
    # Binary file that must be ignored
    (root / "driver.dll").write_bytes(b"\x00\x01\x02O9999")

    client = UsbTransferClient()
    assert client.connect(str(root)) is True

    all_programs = client.list_programs(0)
    by_num_ext = {(p["number"], p["file_extension"]): p for p in all_programs}

    assert (1000, ".PA") in by_num_ext
    assert by_num_ext[(1000, ".PA")]["is_multipath"] is True
    assert by_num_ext[(1000, ".PA")]["channels"] == [1, 2, 3, 4]

    assert (2000, ".P1") in by_num_ext
    assert (2000, ".P2") in by_num_ext
    assert (2000, ".P4") in by_num_ext

    assert (3000, ".M") in by_num_ext
    assert (3000, ".S") in by_num_ext

    assert (4000, "") in by_num_ext
    assert by_num_ext[(4000, "")]["comment"] == "NO EXT"

    assert (5000, ".PRG") in by_num_ext
    assert by_num_ext[(5000, ".PRG")]["comment"] == "CUSTOM EXT"

    assert (6000, "") in by_num_ext
    assert by_num_ext[(6000, "")]["is_multipath"] is True
    assert by_num_ext[(6000, "")]["channels"] == [1, 2]

    assert all(p["number"] != 9999 for p in all_programs)

    # Verify upload by specific extension or container
    assert "<O1000.P4>" in client.upload_program(1000, 0, [".PA"])
    assert "(NO EXT)" in client.upload_program(4000, 1, [""])
    assert "(NO EXT)" in client.upload_program(4000, 1, ["."])
    assert "(P4 PART)" in client.upload_program(2000, 4, [".P4"])


def test_usb_transfer_detects_p_dash_2_nc_cnc_n_and_pa_without_o_prefix(tmp_path):
    root = tmp_path / "usb"
    root.mkdir()
    (root / "O1234.p-2").write_text("O1234\n(P DASH 2)\nM30\n", encoding="utf-8")
    (root / "O1234").write_text("O1234\n(BARE P1)\nM30\n", encoding="utf-8")
    (root / "O1234.cnc").write_text("O1234\n(CNC EXT)\nM30\n", encoding="utf-8")
    (root / "O1234.N").write_text("O1234\n(N EXT)\nM30\n", encoding="utf-8")
    (root / "1500.PA").write_text("<P1>\n(PA WITHOUT O HEADER)\nM30\n<P2>\nM30\n", encoding="utf-8")

    client = UsbTransferClient()
    assert client.connect(str(root)) is True

    all_programs = client.list_programs(0)
    by_num_ext = {(p["number"], p["file_extension"]): p for p in all_programs}

    assert (1234, ".p-2") in by_num_ext
    assert (1234, "") in by_num_ext
    assert (1234, ".cnc") in by_num_ext
    assert (1234, ".N") in by_num_ext
    assert (1500, ".PA") in by_num_ext
    assert by_num_ext[(1500, ".PA")]["is_multipath"] is True
    assert by_num_ext[(1500, ".PA")]["channels"] == [1, 2]


