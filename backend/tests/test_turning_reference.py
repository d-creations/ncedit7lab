import asyncio
import copy
import math
from types import SimpleNamespace

import pytest

from backend import main_import as api
from backend.tests.test_cgiserver_import_regression import FakeRequest
from backend.turning_reference import resolve_turning_references


MACHINE = "FANUC_STAR_SR20R_IV_B"


def execute(program, q=3, radius=0.2, nose=0.2, mounting=(0, 90, 0), overrides=None, position=(0, 0, 0)):
    program = program.replace("T200", "T200 M3", 1)
    config = api.get_machine_config(MACHINE)
    payload = {
        "poseContract": "workpiece-tool-reference-v1", "toolPathMode": "center",
        "machinedata": [{
            "machineName": MACHINE, "canalNr": "1", "program": program,
            "toolValues": [{"toolNumber": 200, "qValue": q, "rValue": radius}],
            "simulation": {"profileRevision": config.simulation_metadata()["profileRevision"],
                           "tools": [{"toolNumber": 200, "reference": "turningVirtualTip",
                                      "mountingOrientationDegrees": list(mounting),
                                      "turningNoseRadius": nose, "turningTipPosition": list(position),
                                      "turningTipOrientation": q}]},
            **(overrides or {}),
        }],
    }
    result = asyncio.run(api.cgiserver_import(FakeRequest(payload)))
    assert result["success"], result
    return result["canal"]["1"]["segments"]


@pytest.mark.parametrize("side,sign", [("G41", 1), ("G42", -1)])
@pytest.mark.parametrize("q,vector", [(0, (0, 0)), (1, (-1, -1)), (2, (1, -1)), (3, (1, 1)),
                                   (4, (-1, 1)), (5, (0, -1)), (6, (1, 0)),
                                   (7, (0, 1)), (8, (-1, 0)), (9, (0, 0))])
@pytest.mark.parametrize("radius", [0, 0.2, 0.4])
@pytest.mark.parametrize("target,tangent", [
    ("X20 Z20", (0, 1)), ("X40 Z0", (1, 0)), ("X40 Z10", (1 / math.sqrt(2), 1 / math.sqrt(2))),
])
def test_actual_engine_reference_and_independent_straight_path(side, sign, q, vector, radius, target, tangent):
    # The second straight block avoids the engine's buffered lead-in endpoint policy.
    mid = {"X20 Z20": "X20 Z10", "X40 Z0": "X30 Z0", "X40 Z10": "X30 Z5"}[target]
    segments = execute(f"T200\nG18 G40 G0 X20 Z0\n{side} G1 {mid} F0.05\nG1 {target}\nG40\nG1 Z25", q, radius)
    steady = next(segment for segment in segments if segment["lineNumber"] == 4)
    end = steady["points"][-1]
    programmed = {"X20 Z20": (10, 20), "X40 Z0": (20, 0), "X40 Z10": (20, 10)}[target]
    # Independent machine-space normal + tool-data Q/R, no frontend compensation.
    expected = (
        programmed[0] - tangent[1] * radius * sign + vector[0] * radius,
        programmed[1] + tangent[0] * radius * sign + vector[1] * radius,
    ) if radius else programmed
    assert (end["x"], end["z"]) == pytest.approx(expected)
    for segment in segments:
        active = segment.get("motionContext", {}).get("toolOffset", {}).get("radiusMode") in ("LEFT", "RIGHT")
        for point, pose in zip(segment["points"], segment.get("poses") or []):
            if "turningReference" in pose:
                assert pose["turningReference"]["tipOrientation"] == q
                # A 90-degree Y mounting maps local (+X,+Z) to world (+Z,-X).
                shift = (vector[1] * 0.2, 0, -vector[0] * 0.2)
                nose_center = [pose["position"][i] + shift[i] for i in range(3)]
                virtual = (0, 0, 0) if active and radius else (vector[0] * 0.2, 0, vector[1] * 0.2)
                assert nose_center == pytest.approx([point["x"] + virtual[0], point["y"], point["z"] + virtual[2]])
            else:
                assert pose["position"] == [point["x"], point["y"], point["z"]]


def test_executed_register_overrides_and_arc_samples_are_not_compensated_twice():
    segments = execute(
        "T200\nG18 G0 X20 Z0\nT2\nG41 G1 Z5 F0.05\nG2 X30 Z10 R5\nG40\nG1 Z12",
        overrides={"toolOffsets": [{"offsetNumber": 2, "qValue": 1, "rValue": 0.4}]},
    )
    arc = next(segment for segment in segments if segment["lineNumber"] == 5)
    assert arc["geometry"] == "ARC_CW"
    assert len(arc["points"]) > 2
    for point, pose in zip(arc["points"], arc["poses"]):
        assert pose["turningReference"] == {
            "kind": "resolved-center-path-v1", "noseRadius": 0.2,
            "tipPosition": [0, 0, 0],
            "tipOrientation": 1, "compensationRadius": 0.4, "radiusMode": "LEFT",
        }
        assert [pose["position"][0] - 0.2, pose["position"][2] + 0.2] == pytest.approx([point["x"], point["z"]])


@pytest.mark.parametrize("side", ["G41", "G42"])
def test_zero_offset_after_reselection_uses_physical_tip_without_inventing_compensation(side):
    segments = execute(
        f"T200\nG18 G0 X20 Z0\nT2\nG1 Z5 F0.05\nT0\nT200\nG18 G0 X20 Z0\n{side} G1 Z5\nG1 Z10\nG40",
        overrides={"toolOffsets": [{"offsetNumber": 2, "qValue": 1, "rValue": 0.4}]},
    )
    steady = next(segment for segment in segments if segment["lineNumber"] == 9)
    offset = steady["motionContext"]["toolOffset"]
    assert offset["radius"] == 0
    assert offset["tipOrientation"] == 3
    point = steady["points"][-1]
    assert (point["x"], point["z"]) == pytest.approx((10, 10))
    for point, pose in zip(steady["points"], steady["poses"]):
        assert pose["turningReference"]["compensationRadius"] == 0
        assert pose["turningReference"]["tipOrientation"] == 3
        assert [pose["position"][0] + 0.2, pose["position"][2] - 0.2] == pytest.approx(
            [point["x"] + 0.2, point["z"] + 0.2],
        )


def test_repeated_feed_is_a_certified_stationary_cut_not_a_missing_endpoint():
    segments = execute("T200\nG18 G0 X20 Z0\nG41 G1 Z5 F0.05\nG1 Z5\nG40")
    stationary = next(segment for segment in segments if segment["lineNumber"] == 4)
    assert stationary["recordKind"] == "motion"
    assert len(stationary["points"]) == len(stationary["poses"]) == 2
    assert stationary["points"][0] == stationary["points"][1]
    assert stationary["poses"][0] == stationary["poses"][1]
    assert stationary["poses"][0]["turningReference"]["radiusMode"] == "LEFT"


@pytest.mark.parametrize("mutation", ["missing", "partial", "translation", "rotation", "invalid", "arc"])
def test_unproven_singletons_remain_incomplete(mutation):
    segment = {
        "geometry": "LINEAR", "traversal": "FEED", "sourceCode": "G01",
        "points": [{"x": 1, "y": 0, "z": 2}],
        "poses": [{"position": [1, 0, 2], "orientation": [0, 0, 0, 1],
                   "frameId": "workpiece:mainSpindle", "reference": "turningVirtualTip"}],
        "motionContext": {"startAxes": {"X": 1, "Y": 0, "Z": 2, "C": 0},
                          "endAxes": {"X": 1, "Y": 0, "Z": 2, "C": 0}},
    }
    if mutation == "missing":
        del segment["motionContext"]["startAxes"]
    elif mutation == "partial":
        del segment["motionContext"]["startAxes"]["Y"]
        del segment["motionContext"]["endAxes"]["Y"]
    elif mutation == "translation":
        segment["motionContext"]["endAxes"]["X"] = 3
    elif mutation == "rotation":
        segment["motionContext"]["endAxes"]["C"] = 180
    elif mutation == "invalid":
        segment["poses"][0]["orientation"] = [0, 0, 0, 0]
    else:
        segment["geometry"] = "ARC_CW"
    api.expand_stationary_linear_motion(segment)
    assert len(segment["points"]) == len(segment["poses"]) == 1


@pytest.mark.parametrize("mounting,shift", [((0, 0, 0), (0.2, 0, 0.2)),
                                          ((0, 90, 0), (0.2, 0, -0.2)),
                                          ((0, 180, 0), (-0.2, 0, -0.2))])
def test_mounting_reference_is_resolved_in_backend(mounting, shift):
    segments = execute("T200\nG18 G0 X20 Z0\nG41 G1 Z10 F0.05\nG1 Z20\nG40", mounting=mounting)
    for segment in segments:
        for point, pose in zip(segment["points"], segment.get("poses") or []):
            if "turningReference" in pose:
                virtual = (0.2, 0, 0.2) if pose["turningReference"]["radiusMode"] == "OFF" else (0, 0, 0)
                assert [pose["position"][i] + shift[i] for i in range(3)] == pytest.approx([point["x"] + virtual[0], point["y"], point["z"] + virtual[2]])


@pytest.mark.parametrize("mode", ["G17", "G19"])
def test_other_planes_are_not_certified(mode):
    segments = execute(f"T200\n{mode} G0 X20 Y0 Z0\nG41 G1 X30 Y5 Z5 F0.05\nG40")
    assert not any("turningReference" in pose for segment in segments for pose in segment.get("poses") or [])


def test_missing_or_invalid_geometry_and_unknown_context_stay_unverified():
    node = SimpleNamespace(g_code={"G18"}, nc_code_line_nr=1)
    state = SimpleNamespace(
        machine_config=SimpleNamespace(default_plane="G18", simulation={"modelId": "STAR_SR20R_IV_B"}),
        tool_path_mode="center",
    )
    control = SimpleNamespace(_canals={1: SimpleNamespace(_exec_sequence=[node])}, get_nc_state=lambda _: state)
    segment = {
        "machiningMode": "turning", "executionStep": 0, "lineNumber": 1, "toolNumber": 200,
        "motionContext": {"toolOffset": {"radiusMode": "LEFT", "radius": 0.2, "tipOrientation": 3}},
        "points": [{"x": 1, "y": 0, "z": 0}] * 2,
        "poses": [{"position": [1, 0, 0], "orientation": [0, 0, 0, 1], "reference": "turningVirtualTip"}] * 2,
    }
    for nose in (None, -1, float("nan"), True):
        output = copy.deepcopy(segment)
        request = {"toolPathMode": "center", "machinedata": [{"simulation": {"tools": [{
            "toolNumber": 200, "reference": "turningVirtualTip", "turningNoseRadius": nose,
        }]}}]}
        resolve_turning_references(control, 1, [output], request, MACHINE)
        assert output == segment


def test_zero_physical_nose_and_mode_changes_keep_their_executed_references():
    segments = execute(
        "T200\nG18 G0 X20 Z0\nG41 G1 Z10 F0.05\nG1 Z20\nG40\nM80\nG1 X25\nM3\nG1 Z25",
        nose=0,
    )
    for segment in segments:
        for point, pose in zip(segment["points"], segment.get("poses") or []):
            assert pose["position"] == [point["x"], point["y"], point["z"]]
            if segment["machiningMode"] != "turning":
                assert "turningReference" not in pose


def test_authored_part_position_is_registered_without_moving_the_executed_nose_path():
    segments = execute("T200\nG18 G0 X20 Z0\nG41 G1 Z10 F0.05\nG1 Z20\nG40", position=(-8, 0, 0))
    for segment in segments:
        for point, pose in zip(segment["points"], segment.get("poses") or []):
            if "turningReference" not in pose:
                continue
            virtual = (0.2, 0, 0.2) if pose["turningReference"]["radiusMode"] == "OFF" else (0, 0, 0)
            # Mounted local physical nose offset is (0.2, 0, 7.8), not a second path offset.
            assert [pose["position"][0] + 0.2, pose["position"][1], pose["position"][2] + 7.8] == pytest.approx(
                [point["x"] + virtual[0], point["y"], point["z"] + virtual[2]],
            )


@pytest.mark.parametrize("nose", [None, -0.1, float("nan"), True])
def test_invalid_reference_request_fails_before_execution(nose):
    from backend.turning_reference import engine_pose_request
    from ncplot7py.domain.simulation_contract import SimulationContractError
    with pytest.raises(SimulationContractError, match="turningNoseRadius"):
        engine_pose_request({"machinedata": [{"canalNr": "1", "simulation": {"tools": [{
            "reference": "turningVirtualTip", "turningNoseRadius": nose,
        }]}}]})
