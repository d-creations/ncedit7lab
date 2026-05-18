from fastapi.testclient import TestClient
import os
import ctypes

from backend.main_import import app, apply_turn_axis_defaults, build_segments_from_engine_output, mock_parse_nc_program
from backend.focas_service import EW_OK, RealFocasClient
from ncplot7py.domain.cnc_state import CNCState


client = TestClient(app)


def test_security_headers_default_deny_framing():
    os.environ.pop("FRAME_ANCESTORS", None)
    resp = client.get("/")
    assert resp.status_code in (200, 307)
    assert resp.headers.get("X-Frame-Options") == "DENY"


def test_security_headers_allow_iframe_with_frame_ancestors():
    os.environ["FRAME_ANCESTORS"] = "https://www.star-ncplot.com"
    resp = client.get("/")
    assert resp.status_code in (200, 307)
    assert "X-Frame-Options" not in resp.headers
    csp = resp.headers.get("Content-Security-Policy", "")
    assert "frame-ancestors" in csp.lower()
    assert "https://www.star-ncplot.com" in csp


def test_list_machines():
    resp = client.post("/ncplot7py/scripts/cgiserver.cgi", json={"action": "list_machines"})
    assert resp.status_code == 200
    j = resp.json()
    assert "success" in j
    assert j.get("success") in (True, False)
    assert ("message" in j) or ("machines" in j) or ("canal" in j)


def test_post_machinedata_minimal():
    payload = {"machinedata": [{"program": "G1 X10 X10", "machineName": "SIEMENS_MILL", "canalNr": "1"}]}
    resp = client.post("/ncplot7py/scripts/cgiserver.cgi", json=payload)
    assert resp.status_code == 200
    j = resp.json()
    assert "success" in j


def test_build_segments_preserves_all_plot_points():
    canal_output = {
        "programExec": [4],
        "plot": [
            {
                "x": [0.0, 35.355, 50.0],
                "y": [50.0, 35.355, 0.0],
                "z": [0.0, 0.0, 0.0],
                "t": 0.5,
            }
        ],
    }

    converted = build_segments_from_engine_output(canal_output)

    assert len(converted["segments"]) == 1
    assert converted["segments"][0]["points"] == [
        {"x": 0.0, "y": 50.0, "z": 0.0},
        {"x": 35.355, "y": 35.355, "z": 0.0},
        {"x": 50.0, "y": 0.0, "z": 0.0},
    ]


def test_build_segments_preserves_variable_snapshot():
    canal_output = {
        "programExec": [1, 2],
        "plot": [],
        "variables": {"1": 4.7, "100": 1.005},
    }

    converted = build_segments_from_engine_output(canal_output)

    assert converted["variables"] == {"1": 4.7, "100": 1.005}


def test_build_segments_prefers_explicit_plot_line_numbers():
    canal_output = {
        "programExec": [2],
        "plot": [
            {
                "x": [0.0, 10.0],
                "y": [0.0, 0.0],
                "z": [0.0, 0.0],
                "t": 0.1,
                "lineNumber": 5,
            }
        ],
    }

    converted = build_segments_from_engine_output(canal_output)

    assert converted["segments"][0]["lineNumber"] == 5

def test_mock_parser_treats_h_as_incremental_c_rotation():
    result = mock_parse_nc_program("G1 X0 Y50\nG1 C90\nG1 H90", "SIEMENS_MILL")

    last_segment = result["segments"][-1]
    assert len(last_segment["points"]) > 2
    assert last_segment["points"][0]["x"] == -50.0
    assert last_segment["points"][0]["y"] == 0.0
    assert round(last_segment["points"][-1]["x"], 6) == 0.0
    assert round(last_segment["points"][-1]["y"], 6) == -50.0


def test_apply_turn_axis_defaults_sets_x_to_diameter():
    state = CNCState()

    apply_turn_axis_defaults([state])

    assert state.get_axis_unit("X") == "diameter"

def test_apply_turn_axis_defaults_sets_y_to_diameter_for_sr20jii():
    state = CNCState()

    apply_turn_axis_defaults([state], "SR20JII_F")

    assert state.get_axis_unit("X") == "diameter"
    assert state.get_axis_unit("Y") == "diameter"


def test_real_focas_upload_program_reads_until_trailing_percent():
    class UploadLibStub:
        def __init__(self):
            self.chunks = [
                b"%\nO1234\nG1 X1.\n",
                b"G1 X2.\nM30\n%",
            ]
            self.upend_calls = 0

        def cnc_upstart3(self, handle, mode, start_prog, end_prog):
            return EW_OK

        def cnc_upload3(self, handle, length_ptr, buffer):
            chunk = self.chunks.pop(0)
            ctypes.memmove(buffer, chunk, len(chunk))
            length_ptr._obj.value = len(chunk)
            return EW_OK

        def cnc_upend3(self, handle):
            self.upend_calls += 1
            return EW_OK

    client_instance = RealFocasClient.__new__(RealFocasClient)
    client_instance.lib = UploadLibStub()
    client_instance.handle = ctypes.c_ushort(1)
    client_instance.set_path = lambda path_no: None

    program_text = client_instance.upload_program(1234)

    assert program_text == "%\nO1234\nG1 X1.\nG1 X2.\nM30\n%"
    assert client_instance.lib.upend_calls == 1
