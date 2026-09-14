import asyncio
import base64
import builtins
import hashlib
import hmac
import json
import math
from dataclasses import replace
import contextlib
import importlib.machinery
import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import pytest

from backend import main_import as api


@pytest.fixture(params=["fastapi", "cgi"])
def execution_adapter(request):
    if request.param == "fastapi":
        return api
    import ncplot7py
    script = Path(ncplot7py.__file__).resolve().parents[2] / "scripts" / "cgiserver.cgi"
    if not script.exists():
        pytest.skip("CGI parity requires the engine source checkout")
    loader = importlib.machinery.SourceFileLoader("cgi_contract_test", str(script))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    with contextlib.redirect_stdout(io.StringIO()):
        loader.exec_module(module)
    return module


def execute_adapter(adapter, payload):
    if adapter is api:
        return asyncio.run(api.cgiserver_import(FakeRequest(payload)))
    return adapter.handle_execute_programs(
        payload["machinedata"], payload.get("toolPathMode", "effective"), request_payload=payload,
    )


@pytest.mark.parametrize("machine,selection", [("FANUC_MILL", "T1"), ("SIEMENS_840DI", 'T="CUTTER"')])
@pytest.mark.parametrize("command", ["G41", "G42"])
def test_r0_in_explicit_register_does_not_fall_back_to_tool_radius(execution_adapter, machine, selection, command):
    tool_id = 1 if machine == "FANUC_MILL" else "CUTTER"
    offset = {"offsetNumber": 2, "rValue": 0}
    if isinstance(tool_id, str):
        offset["toolNumber"] = tool_id
    payload = {"toolPathMode": "center", "machinedata": [{
        "machineName": machine, "canalNr": "1",
        "program": selection + f"\nG17 G90\nD2\n{command} G1 X10 Y0 F100\nG1 X20 Y0\nG40",
        "toolValues": [{"toolNumber": tool_id, "rValue": 7}], "toolOffsets": [offset],
    }]}
    result = execute_adapter(execution_adapter, payload)
    assert result["success"] is True
    assert result["executionOrigin"] == "engine"
    assert not result.get("errors")
    assert result["canal"]["1"]["segments"][-1]["points"][-1]["y"] == 0
    assert result["canal"]["1"]["segments"][-1]["toolNumber"] == tool_id


def test_negative_radius_fails_without_mock(execution_adapter):
    result = execute_adapter(execution_adapter, {"toolPathMode": "center", "machinedata": [{
        "machineName": "FANUC_MILL", "canalNr": "1", "program": "T1\nG41 G1 X10 F100",
        "toolValues": [{"toolNumber": 1, "rValue": -1}],
    }]})
    assert result["success"] is False
    assert result["canal"] == {}
    assert result["errors"]


def test_undefined_tool_uses_zero_radius_and_keeps_path(execution_adapter):
    result = execute_adapter(execution_adapter, {"toolPathMode": "center", "machinedata": [{
        "machineName": "FANUC_MILL", "canalNr": "1",
        "program": "T999\nG0 X0 Y0\nG41 G1 X10 Y0 F100\nG1 X20 Y0\nG40",
    }]})
    assert result["success"] is True
    points = result["canal"]["1"]["segments"][-1]["points"]
    assert points[-1]["y"] == pytest.approx(0)


def test_pose_negotiation_never_executes_or_downgrades(execution_adapter, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Unsupported pose request must not execute")
    monkeypatch.setattr(execution_adapter, "NCExecutionEngine", forbidden)
    config = execution_adapter.get_machine_config("FANUC_TURN")
    metadata = config.simulation_metadata()
    assert metadata["supportedPoseContracts"] == []
    payload = {"poseContract": "workpiece-tool-reference-v1", "toolPathMode": "center", "machinedata": [{
        "machineName": "FANUC_TURN", "canalNr": "1", "program": "T1",
        "simulation": {"profileRevision": metadata["profileRevision"], "tools": []},
    }]}
    result = execute_adapter(execution_adapter, payload)
    assert result["success"] is False
    assert result["errors"][0]["code"] == "POSE_CONTRACT_UNSUPPORTED"
    payload["machinedata"][0]["simulation"]["profileRevision"] = "old"
    assert execute_adapter(execution_adapter, payload)["errors"][0]["code"] == "PROFILE_REVISION_MISMATCH"


def test_failed_engine_is_not_replaced_and_empty_output_is_valid(execution_adapter, monkeypatch):
    class EmptyEngine:
        errors = []
        def __init__(self, control):
            pass
        def get_Syncro_plot(self, programs, sync):
            return [{"plot": [], "programExec": []}]
    monkeypatch.setattr(execution_adapter, "NCExecutionEngine", EmptyEngine)
    payload = {"machinedata": [{"machineName": "FANUC_MILL", "canalNr": "1", "program": "G0 X1"}]}
    result = execute_adapter(execution_adapter, payload)
    assert result["success"] is True
    assert result["canal"]["1"]["segments"] == []
    def failed(*args, **kwargs):
        raise RuntimeError("offline")
    monkeypatch.setattr(execution_adapter, "NCExecutionEngine", failed)
    result = execute_adapter(execution_adapter, payload)
    assert result["success"] is False
    assert result["canal"] == {}
    assert result["errors"][0]["code"] == "ENGINE_EXECUTION_FAILED"


@pytest.mark.parametrize("radius", [0, 2])
def test_center_request_preserves_zero_radius_and_applies_nonzero_radius(radius):
    payload = {"toolPathMode": "center", "machinedata": [{
        "machineName": "FANUC_MILL", "canalNr": "1",
        "program": "T1\nG17 G90\nG0 X0 Y0 Z0\nG41 G1 X10 Y0 F100\nG1 X20 Y0\nG40",
        "toolValues": [{"toolNumber": 1, "rValue": radius}],
    }]}
    body = asyncio.run(api.cgiserver_import(FakeRequest(payload)))
    assert body["success"] is True
    assert not body.get("errors")
    segment = body["canal"]["1"]["segments"][-1]
    assert segment["toolNumber"] == 1
    assert segment["points"][-1]["y"] == pytest.approx(radius)


def test_multichannel_plot_executes_once_with_independent_radii(execution_adapter, monkeypatch):
    created = []
    original = execution_adapter.NCExecutionEngine
    def capture(control):
        created.append(control)
        return original(control)
    monkeypatch.setattr(execution_adapter, "NCExecutionEngine", capture)
    result = execute_adapter(execution_adapter, {"toolPathMode": "center", "machinedata": [
        {"machineName": "FANUC_MILL", "canalNr": str(channel),
         "program": "T1\nG17\nG41 G1 X10 Y0 F100\nG1 X20 Y0\nG40",
         "toolValues": [{"toolNumber": 1, "rValue": radius}]}
        for channel, radius in [(1, 0), (2, 2)]
    ]})
    assert result["success"] is True
    assert len(created) == 1
    assert result["canal"]["1"]["segments"][-1]["points"][-1]["y"] == 0
    assert result["canal"]["2"]["segments"][-1]["points"][-1]["y"] == 2


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


def test_build_segments_preserves_immutable_motion_context():
    context = {
        "channelId": "1", "startAxes": {"X": 0.0, "B": 0.0, "C": 0.0},
        "endAxes": {"X": 10.0, "B": 90.0, "C": 45.0},
        "toolOffset": {"number": 2, "radiusMode": "LEFT", "radius": 0},
    }
    converted = api.build_segments_from_engine_output({"plot": [{
        "x": [0, 1], "y": [0, 0], "z": [0, 0], "motionContext": context,
    }]})

    assert converted["segments"][0]["motionContext"] == context


def test_mill_demo_engine_captures_actual_motion_axis_endpoints():
    payload = {"toolPathMode": "center", "machinedata": [{
        "machineName": "FANUC_MILL_DEMO", "canalNr": "1",
        "program": "T1\nG17 G90\nG0 X1 Y2 Z3 B90 C45",
    }]}
    result = asyncio.run(api.cgiserver_import(FakeRequest(payload)))

    assert result["success"] is True
    context = result["canal"]["1"]["segments"][0]["motionContext"]
    assert context["channelId"] == "1"
    assert context["startAxes"] == {"X": 0.0, "Y": 0.0, "Z": 0.0, "B": 0.0, "C": 0.0}
    assert context["endAxes"] == {"X": 1.0, "Y": 2.0, "Z": 3.0, "B": 90.0, "C": 45.0}
    assert context["toolOffset"] == {"radiusMode": "OFF"}


def test_mill_demo_pose_request_returns_workpiece_frame_pose(execution_adapter):
    config = execution_adapter.get_machine_config("FANUC_MILL_DEMO")
    payload = {"poseContract": "workpiece-tool-reference-v1", "toolPathMode": "center", "machinedata": [{
        "machineName": "FANUC_MILL_DEMO", "canalNr": "1",
        "program": "T1\nG17 G90\nG0 X1 Y2 Z3 B90 C0",
        "simulation": {"profileRevision": config.simulation_metadata()["profileRevision"], "tools": [{
            "toolNumber": 1, "reference": "millingTip", "mountingOrientationDegrees": [0, 0, 0],
        }]},
    }]}
    result = execute_adapter(execution_adapter, payload)

    assert result["success"] is True
    segment = result["canal"]["1"]["segments"][0]
    assert len(segment["poses"]) == len(segment["points"])
    _assert_close_tuple(segment["poses"][0]["orientation"], [0, 0, 0, 1])
    pose = segment["poses"][-1]
    point = segment["points"][-1]
    assert pose["position"] == [point["x"], point["y"], point["z"]]
    assert pose["reference"] == "millingTip"
    assert pose["frameId"] == "workpiece:tableBC"
    _assert_close_tuple(pose["orientation"], [0, -math.sqrt(0.5), 0, math.sqrt(0.5)])


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
    config = replace(api.get_machine_config("FANUC_MILL"), file_extensions={})
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
    assert body["machines"][0]["axes"] == list(config.axes)
    assert body["machines"][0]["availableChannels"] == config.channels
    assert body["machines"][0]["profileRevision"].startswith("sha256:")
    assert body["machines"][0]["supportedPoseContracts"] == ["workpiece-tool-reference-v1"]
    assert body["machines"][0]["simulationCommentSyntax"] == {
        "kind": "block", "open": "(", "close": ")",
    }
    assert requested_regex_profiles == ["FANUC_MILL"]


def test_simulation_comment_capabilities_are_explicit_and_bounded():
    assert api.get_simulation_comment_syntax("SIEMENS") == {"kind": "line", "prefix": ";"}
    assert api.get_simulation_comment_syntax("UNKNOWN") is None


def test_machine_discovery_exposes_explicit_mill_demo_profiles():
    machines = {
        machine["machineName"]: machine
        for machine in api.list_machines()["machines"]
    }
    for name, control_type in [("FANUC_MILL_DEMO", "FANUC"), ("SIEMENS_MILL_DEMO", "SIEMENS")]:
        machine = machines[name]
        assert machine["controlType"] == control_type
        assert machine["axes"] == ["X", "Y", "Z", "B", "C"]
        assert machine["availableChannels"] == 1
        assert machine["supportedPoseContracts"] == ["workpiece-tool-reference-v1"]
        assert machine["simulation"]["modelId"] == "MILL_DEMO"
        assert machine["simulation"]["toolMounts"][0]["carrierId"] == "millingSpindle"


def test_machine_discovery_exposes_production_b_c_mill_profiles():
    machines = {
        machine["machineName"]: machine
        for machine in api.list_machines()["machines"]
    }
    for name, control_type in [("FANUC_MILL", "FANUC"), ("SIEMENS_840DI", "SIEMENS")]:
        machine = machines[name]
        assert machine["controlType"] == control_type
        assert machine["axes"] == ["X", "Y", "Z", "B", "C"]
        assert machine["availableChannels"] == 1
        assert machine["supportedPoseContracts"] == ["workpiece-tool-reference-v1"]
        assert machine["simulation"]["modelId"] == "MILL_DEMO"


def test_machine_discovery_exposes_requested_star_models_and_channels():
    machines = {
        machine["machineName"]: machine
        for machine in api.list_machines()["machines"]
    }
    expected = {
        "FANUC_STAR_SR20R_IV_B": (2, "STAR_SR20R_IV_B", "B1"),
        "FANUC_STAR_SV20R": (3, "STAR_SV20R", "X3"),
        "FANUC_STAR_SG42": (2, "STAR_SG42", "ZB"),
    }
    for name, (channels, model_id, axis) in expected.items():
        machine = machines[name]
        assert machine["availableChannels"] == channels
        assert axis in machine["axes"]
        assert machine["simulation"]["modelId"] == model_id
        assert machine["supportedPoseContracts"] == ["workpiece-tool-reference-v1"]


def test_sr20r_fixed_target_pose_projector_resolves_c1_and_turning_tip():
    from ncplot7py.domain.machines import get_machine_config
    from ncplot7py.domain.tool_pose import project_fixed_target_poses

    config = get_machine_config("FANUC_STAR_SR20R_IV_B")
    poses = project_fixed_target_poses(
        [{"x": 1.0, "y": 2.0, "z": 3.0}, {"x": 2.0, "y": 2.0, "z": 3.0}],
        {
            "startAxes": {"X1": 0.0, "Y1": 0.0, "Z1": 0.0, "C1": 0.0},
            "endAxes": {"X1": 0.0, "Y1": 0.0, "Z1": 0.0, "C1": 90.0},
        },
        [0.0, 0.0, 0.0],
        config.simulation,
        "1",
        1,
        "turningVirtualTip",
    )

    assert len(poses) == 2
    assert poses[0]["reference"] == "turningVirtualTip"
    assert poses[0]["frameId"] == "workpiece:mainSpindle"
    assert poses[0]["position"] == [1.0, 2.0, 3.0]
    _assert_close_tuple(poses[-1]["orientation"], [0, 0, -math.sqrt(0.5), math.sqrt(0.5)])


def test_star_dynamic_target_context_uses_config_default_and_m171_m172():
    from ncplot7py.domain.cnc_state import CNCState
    from ncplot7py.domain.handlers.star_machine.mcode_modal import StarModalMCodeHandler
    from ncplot7py.domain.machines import get_machine_config
    from ncplot7py.infrastructure.machines.base_stateful_control import BaseStatefulCanal

    config = get_machine_config("FANUC_STAR_SV20R")
    state = CNCState(machine_config=config)
    state.extra["active_tool_number"] = 31
    canal = BaseStatefulCanal.__new__(BaseStatefulCanal)
    canal._name = "3"
    canal._state = state
    canal._initialize_configured_target()

    assert canal._resolve_motion_target() == {
        "toolCarrierId": "turret",
        "targetCarrierId": "mainSpindle",
        "targetAxis": "C1",
    }

    handler = StarModalMCodeHandler()
    handler._apply_machine_specific_state("M172", state)
    assert canal._resolve_motion_target()["targetCarrierId"] == "subSpindle"
    assert canal._resolve_motion_target()["targetAxis"] == "C2"

    handler._apply_machine_specific_state("M171", state)
    assert canal._resolve_motion_target()["targetCarrierId"] == "mainSpindle"
    assert canal._resolve_motion_target()["targetAxis"] == "C1"


@pytest.mark.parametrize("machine_name, channel_id, tool_number", [
    ("FANUC_STAR_SV20R", "3", 31),
    ("FANUC_STAR_SG42", "1", 1),
])
def test_dynamic_star_pose_uses_motion_target(machine_name, channel_id, tool_number):
    from ncplot7py.domain.machines import get_machine_config
    from ncplot7py.domain.tool_pose import project_fixed_target_poses

    config = get_machine_config(machine_name)
    poses = project_fixed_target_poses(
        [{"x": 1.0, "y": 2.0, "z": 3.0}],
        {
            "startAxes": {"C1": 0.0, "C2": 0.0},
            "endAxes": {"C1": 90.0, "C2": 90.0},
            "targetCarrierId": "subSpindle",
        },
        [0.0, 0.0, 0.0], config.simulation, channel_id, tool_number,
        "turningVirtualTip",
    )

    assert poses[0]["frameId"] == "workpiece:subSpindle"
    _assert_close_tuple(poses[0]["orientation"], [0, 0, -math.sqrt(0.5), math.sqrt(0.5)])


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