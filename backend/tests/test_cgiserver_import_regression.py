import asyncio
import base64
import builtins
import hashlib
import hmac
import json
from types import SimpleNamespace
import pytest

from backend import main_import as api


def test_api_loads_channel_scoped_offsets_and_preserves_named_ids(monkeypatch):
    loaded = []
    original_loader = api.load_tool_data

    def capture(state, tools, offsets):
        original_loader(state, tools, offsets)
        loaded.append(state.extra)

    monkeypatch.setattr(api, "load_tool_data", capture)
    payload = {"machinedata": [
        {"machineName": "SIEMENS_840DI", "canalNr": "1", "program": "G0 X1",
         "toolValues": [{"toolNumber": 1}, {"toolNumber": "1"}],
         "toolOffsets": [{"toolNumber": "1", "offsetNumber": 2, "rValue": 0.4}]},
        {"machineName": "SIEMENS_840DI", "canalNr": "2", "program": "G0 X2",
         "toolOffsets": [{"toolNumber": "1", "offsetNumber": 2, "rValue": 0.8}]},
    ]}
    asyncio.run(api.cgiserver_import(FakeRequest(payload)))
    assert set(loaded[0]["tool_compensation_data"]) == {1, "1"}
    assert loaded[0]["tool_offset_data"][("1", 2)]["rValue"] == 0.4
    assert loaded[1]["tool_offset_data"][("1", 2)]["rValue"] == 0.8


def test_api_rejects_invalid_offset_data():
    payload = {"machinedata": [{"machineName": "FANUC_MILL", "program": "T1",
                               "toolOffsets": [{"offsetNumber": -1}]}]}
    with pytest.raises(api.HTTPException) as error:
        asyncio.run(api.cgiserver_import(FakeRequest(payload)))
    assert error.value.status_code == 400


class FakeRequest:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode("utf-8")
        self.method = "POST"
        self.url = SimpleNamespace(path="/cgiserver_import")
        self.headers = {"content-type": "application/json"}

    async def body(self):
        return self._payload


def _assert_close_tuple(left, right, tolerance=1e-4):
    assert len(left) == len(right)
    for left_value, right_value in zip(left, right):
        assert abs(left_value - right_value) <= tolerance


def test_build_segments_preserves_explicit_motion_semantics():
    converted = api.build_segments_from_engine_output({
        "programExec": [10, 20],
        "plot": [
            {
                "x": [0.0, 5.0],
                "y": [0.0, 0.0],
                "z": [0.0, 0.0],
                "t": 1.5,
                "geometry": "LINEAR",
                "traversal": "RAPID",
                "sourceCode": "G00",
                "lineNumber": 10,
            },
            {
                "x": [5.0, 10.0],
                "y": [0.0, 5.0],
                "z": [0.0, 0.0],
                "t": 0.0,
                "geometry": "ARC_CW",
                "traversal": "FEED",
                "sourceCode": "G02",
                "lineNumber": 20,
            },
        ],
    })

    assert "type" not in converted["segments"][0]
    assert converted["segments"][0]["geometry"] == "LINEAR"
    assert converted["segments"][1]["geometry"] == "ARC_CW"
    assert converted["segments"][1]["traversal"] == "FEED"
    assert converted["executedLines"] == [10, 20]


def test_build_segments_does_not_infer_motion_from_timing():
    converted = api.build_segments_from_engine_output({
        "plot": [{
            "x": [0.0, 1.0],
            "y": [0.0, 0.0],
            "z": [0.0, 0.0],
            "t": 0.0,
        }],
    })

    segment = converted["segments"][0]
    assert "type" not in segment
    assert segment["geometry"] is None
    assert segment["traversal"] is None


def test_build_segments_preserves_execution_occurrences_and_active_tools():
    # Repeated lines are distinct occurrences; cycle primitives share a step.
    entries = [
        {"lineNumber": 10, "executionStep": 0, "toolNumber": 0},
        {"lineNumber": 20, "executionStep": 5, "toolNumber": 2},
        {"lineNumber": 20, "executionStep": 5, "toolNumber": 2},
        {"lineNumber": 10, "executionStep": 9, "toolNumber": "DRILL_8"},
        {"lineNumber": 30, "executionStep": 10, "toolNumber": "unknown"},
        {"lineNumber": 40},
        {"lineNumber": 50, "executionStep": None, "toolNumber": None},
    ]
    converted = api.build_segments_from_engine_output({
        "plot": [
            {"x": [0, 1], "y": [0, 0], "z": [0, 0], "t": 0.5, **entry}
            for entry in entries
        ],
    })

    assert [s["toolNumber"] for s in converted["segments"]] == [
        0, 2, 2, "DRILL_8", "unknown", "unknown", None,
    ]
    assert [s["executionStep"] for s in converted["segments"]] == [
        0, 5, 5, 9, 10, None, None,
    ]
    assert converted["executedLines"] == [10, 20, 20, 10, 30, 40, 50]
    assert converted["timing"] == [0.5] * len(entries)
    assert converted["lineTiming"]["20"] == 1.0

    # A separate conversion must not inherit a previous channel's last tool.
    other = api.build_segments_from_engine_output({"plot": [{"x": [0, 1]}]})
    assert other["segments"][0]["toolNumber"] == "unknown"
    assert other["segments"][0]["executionStep"] is None


def test_nc_request_telemetry_uses_identity_without_program_content(monkeypatch):
    hmac_key = bytes(range(32))
    monkeypatch.setenv("TELEMETRY_USER_HMAC_KEY", base64.b64encode(hmac_key).decode("ascii"))
    request = FakeRequest({})
    request.headers["x-ms-client-principal-id"] = "azure-user-123"
    request.headers["x-ncedit-client-id"] = "browser-456"

    digest = hmac.new(
        hmac_key,
        b"ncedit7:appinsights-user:v1:azure-user-123",
        hashlib.sha256,
    ).digest()
    expected_user_id = "v1_" + base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    assert api.get_request_identity(request) == (expected_user_id, "azure_principal")

    class FakeSpan:
        def __init__(self):
            self.attributes = {}

        def set_attribute(self, name, value):
            self.attributes[name] = value

    span = FakeSpan()
    assert api.set_request_user_context(request, span) == (expected_user_id, "azure_principal")
    assert span.attributes == {"enduser.pseudo.id": expected_user_id}
    assert "azure-user-123" not in json.dumps(span.attributes)

    browser_request = FakeRequest({})
    browser_request.headers["x-ncedit-client-id"] = "browser-456"
    browser_span = FakeSpan()
    assert api.set_request_user_context(browser_request, browser_span) == ("browser-456", "browser")
    assert browser_span.attributes == {"enduser.pseudo.id": "browser-456"}

    summary = api.summarize_nc_request({
        "machinedata": [
            {"program": "SECRET NC CODE", "machineName": "FANUC", "canalNr": "1"},
            {"program": "G1 X10", "machineName": "FANUC", "canalNr": "2"},
        ]
    })

    assert summary == {
        "action": "plot",
        "channel_count": 2,
        "program_chars": 20,
        "machines": ["FANUC"],
    }
    assert "SECRET" not in json.dumps(summary)


def test_azure_identity_without_hmac_key_falls_back_without_leaking_principal(monkeypatch):
    monkeypatch.delenv("TELEMETRY_USER_HMAC_KEY", raising=False)
    request = FakeRequest({})
    request.headers["x-ms-client-principal-id"] = "azure-user-123"
    request.headers["x-ncedit-client-id"] = "browser-456"

    assert api.get_request_identity(request) == ("browser-456", "browser")

    del request.headers["x-ncedit-client-id"]
    assert api.get_request_identity(request) == ("anonymous", "none")


def test_request_identity_does_not_require_opentelemetry_when_monitor_is_disabled(monkeypatch):
    request = FakeRequest({})
    request.headers["x-ncedit-client-id"] = "browser-456"
    real_import = builtins.__import__

    def reject_opentelemetry_import(name, *args, **kwargs):
        if name == "opentelemetry" or name.startswith("opentelemetry."):
            raise ModuleNotFoundError("No module named 'opentelemetry'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(api, "azure_monitor_enabled", False)
    monkeypatch.setattr(builtins, "__import__", reject_opentelemetry_import)

    assert api.set_request_user_context(request) == ("browser-456", "browser")


def test_cgiserver_import_returns_line_alignment_syntax():
    body = asyncio.run(api.cgiserver_import(FakeRequest({
        "action": "get_line_alignment_syntax",
    })))

    assert body["success"] is True
    definitions = {
        definition["controlType"]: definition
        for definition in body["lineAlignmentSyntax"]
    }
    assert definitions["FANUC"]["twoChannel"]["syntax"] == "M<waitCode>"
    assert definitions["FANUC"]["threeChannel"]["syntax"] == "M<waitCode> P<channels>"
    assert definitions["SIEMENS"]["syntax"] == "WAITM(<marker>)"


def test_list_machines_uses_configured_control_family(monkeypatch):
    machine = {"machineName": "FANUC_MILL", "controlType": "FANUC_MILL"}
    requested_regex_profiles = []
    config = SimpleNamespace(
        control_type="FANUC",
        machine_type="MILL",
        variable_prefix="#",
        file_extensions={},
    )
    monkeypatch.setattr(api, "get_available_machines", lambda: [machine])
    monkeypatch.setattr(
        api,
        "get_machine_regex_patterns",
        lambda machine_name: requested_regex_profiles.append(machine_name) or {},
    )
    monkeypatch.setattr(api, "get_machine_config", lambda _machine_name: config)

    body = api.list_machines()

    assert body["machines"][0]["controlType"] == "FANUC"
    assert body["machines"][0]["machineType"] == "MILL"
    assert body["machines"][0]["simulationCommentSyntax"] == {
        "kind": "block", "open": "(", "close": ")",
    }
    assert requested_regex_profiles == ["FANUC_MILL"]


def test_simulation_comment_capabilities_are_explicit_and_bounded():
    assert api.get_simulation_comment_syntax("SIEMENS") == {"kind": "line", "prefix": ";"}
    assert api.get_simulation_comment_syntax("UNKNOWN") is None


def test_cgiserver_import_preserves_o0017_g112_xy_ij_parity_for_star_machine():
    g112_program = """
G18
G112
G01 X0.0 C0.0 F80
G98 F200 G17
G1 Z0.6514
G1 X0.001 C0.215
G2 X0 C0.86 R0.225
G3 X0.6549 C0.9855 I0 J0.49 W0.0088 F388.6531
G2 X1.3795 C0.7763 I0.147 J-0.1637 W0.0067 F25.0909
G3 X2.0344 C0.2092 I0.4794 J-0.1013 W0.0088 F388.6531
G113
""".strip()

    xy_program = """
G17
G01 X0.0 Y0.0 F80
G98 F200 G17
G1 Z0.6514
G1 X0.001 Y0.43
G2 X0 Y1.72 R0.225
G3 X0.6549 Y1.971 I0 J0.49 W0.0088 F388.6531
G2 X1.3795 Y1.5527 I0.147 J-0.1637 W0.0067 F25.0909
G3 X2.0344 Y0.4183 I0.4794 J-0.1013 W0.0088 F388.6531
""".strip()

    async def run_case(program: str):
        payload = {
            "machinedata": [
                {
                    "program": program,
                    "machineName": "FANUC_STAR_x-D_y-D_z_R",
                    "canalNr": "1",
                    "toolValues": [],
                    "customVariables": [],
                }
            ]
        }
        body = await api.cgiserver_import(FakeRequest(payload))
        assert body.get("errors") in (None, [])

        canal = body["canal"]["1"]
        segments = canal["segments"]
        points = []
        for seg in segments:
            points.extend(seg.get("points", []))

        xs = [float(pt["x"]) for pt in points if "x" in pt]
        ys = [float(pt["y"]) for pt in points if "y" in pt]
        assert segments
        assert xs
        assert ys

        return {
            "segment_count": len(segments),
            "point_count": len(points),
            "x_range": (min(xs), max(xs)),
            "y_range": (min(ys), max(ys)),
        }

    g112_case = asyncio.run(run_case(g112_program))
    xy_case = asyncio.run(run_case(xy_program))

    assert g112_case["segment_count"] == xy_case["segment_count"]
    assert g112_case["point_count"] == xy_case["point_count"]
    _assert_close_tuple(g112_case["x_range"], xy_case["x_range"])
    _assert_close_tuple(g112_case["y_range"], xy_case["y_range"])


def test_cgiserver_import_returns_siemens_named_variables_without_motion():
    payload = {
        "machinedata": [
            {
                "program": "DEF REAL CUSTOM_MC[4]\nCUSTOM_MC[3]=12.5\nANGLE_Z=ATAN2(30,40)",
                "machineName": "SIEMENS_840DI",
                "canalNr": "1",
                "toolValues": [],
                "customVariables": [],
            }
        ]
    }

    body = asyncio.run(api.cgiserver_import(FakeRequest(payload)))
    canal = body["canal"]["1"]

    assert canal["segments"] == []
    assert canal["variables"] == {}
    assert abs(canal["namedVariables"]["CUSTOM_MC[3]"] - 12.5) <= 1e-6
    assert abs(canal["namedVariables"]["ANGLE_Z"] - 36.869897) <= 1e-5