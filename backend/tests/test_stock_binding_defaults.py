from copy import deepcopy
from dataclasses import replace

import pytest

from backend import main_import as api
from ncplot7py.domain.machines import get_machine_config, validate_simulation_config


PROFILE_BINDINGS = [
    ("FANUC_MILL", ["workpiece:tableBC"]),
    ("SIEMENS_840DI", ["workpiece:tableBC"]),
    ("FANUC_MILL_DEMO", ["workpiece:tableBC"]),
    ("SIEMENS_MILL_DEMO", ["workpiece:tableBC"]),
    ("FANUC_STAR_SR20R_IV_B", ["workpiece:mainSpindle", "workpiece:subSpindle"]),
    ("FANUC_STAR_SV20R", ["workpiece:mainSpindle", "workpiece:subSpindle"]),
    ("FANUC_STAR_SG42", ["workpiece:mainSpindle", "workpiece:subSpindle"]),
]


@pytest.mark.parametrize("machine_name, expected_frames", PROFILE_BINDINGS)
def test_backend_exposes_explicit_stock_defaults_and_revision(machine_name, expected_frames):
    config = get_machine_config(machine_name)
    metadata = config.simulation_metadata()
    defaults = metadata["simulation"]["stockBindings"]
    assert [binding["frameId"] for binding in defaults] == expected_frames
    assert metadata["simulation"]["revision"] == 2
    for binding in defaults:
        assert binding["position"] == binding["rotation"] == binding["spindleOrigin"] == [0, 0, 0]
        assert binding["spindleAxis"] == [0, 0, 1]
    response = api.list_machines()
    machine = next(m for m in response["machines"] if m["machineName"] == config.name)
    assert machine["simulation"]["stockBindings"] == defaults
    changed = deepcopy(config.simulation)
    changed["stockBindings"][0]["position"][0] = 1
    assert replace(config, simulation=changed).simulation_metadata()["profileRevision"] != metadata["profileRevision"]
    assert config.simulation["stockBindings"][0]["position"] == [0, 0, 0]


@pytest.mark.parametrize("case", ["duplicate", "unknown", "zero-axis", "nan", "boolean", "oversized", "extra"])
def test_invalid_stock_defaults_fail_explicitly(case):
    config = get_machine_config("FANUC_STAR_SR20R_IV_B")
    simulation = deepcopy(config.simulation)
    binding = simulation["stockBindings"][0]
    if case == "duplicate":
        simulation["stockBindings"].append(deepcopy(binding))
    elif case == "unknown":
        binding["frameId"] = "workpiece:gangToolPost"
    elif case == "zero-axis":
        binding["spindleAxis"] = [0, 0, 0]
    elif case == "nan":
        binding["position"][0] = float("nan")
    elif case == "boolean":
        binding["rotation"][0] = True
    elif case == "oversized":
        binding["spindleOrigin"][0] = 1_000_001
    else:
        binding["extra"] = 0
    with pytest.raises(ValueError):
        validate_simulation_config(simulation, config.channels, config.axes)


@pytest.mark.parametrize("machine_name", [name for name, _ in PROFILE_BINDINGS])
def test_legacy_profiles_without_defaults_remain_supported(machine_name):
    config = get_machine_config(machine_name)
    simulation = deepcopy(config.simulation)
    del simulation["stockBindings"]
    assert "stockBindings" not in validate_simulation_config(simulation, config.channels, config.axes)


@pytest.mark.parametrize("machine_name, carrier, tool, reference, rotation_axis", [
    ("FANUC_MILL", "tableBC", 1, "millingTip", "C"),
    ("SIEMENS_840DI", "tableBC", 1, "millingTip", "C"),
    ("FANUC_MILL_DEMO", "tableBC", 1, "millingTip", "C"),
    ("SIEMENS_MILL_DEMO", "tableBC", 1, "millingTip", "C"),
    ("FANUC_STAR_SR20R_IV_B", "mainSpindle", 100, "turningVirtualTip", "C1"),
    ("FANUC_STAR_SV20R", "mainSpindle", 100, "turningVirtualTip", "C1"),
    ("FANUC_STAR_SG42", "mainSpindle", 1, "turningVirtualTip", "C1"),
])
def test_stock_defaults_do_not_change_executed_tool_poses(
    machine_name, carrier, tool, reference, rotation_axis
):
    from ncplot7py.domain.tool_pose import project_fixed_target_poses

    config = get_machine_config(machine_name)
    baseline = deepcopy(config.simulation)
    del baseline["stockBindings"]
    baseline["revision"] = 1
    points = [{"x": 1.0, "y": 2.0, "z": 3.0}, {"x": 2.0, "y": 2.0, "z": 3.0}]
    axes = {axis: 0.0 for axis in config.axes}
    axes.update(config.simulation.get("initialAxes", {}))
    context = {
        "startAxes": axes,
        "endAxes": {**axes, rotation_axis: 90.0},
        "targetCarrierId": carrier,
    }
    poses = project_fixed_target_poses(
        points, context, [0.0, 0.0, 0.0], config.simulation, "1", tool, reference
    )
    assert poses == project_fixed_target_poses(
        points, context, [0.0, 0.0, 0.0], baseline, "1", tool, reference
    )


def test_profiles_without_simulation_do_not_acquire_invented_stock_defaults():
    machines = api.list_machines()["machines"]
    legacy = [machine for machine in machines if get_machine_config(machine["machineName"]).simulation is None]
    assert legacy
    for machine in legacy:
        assert "simulation" not in machine
        assert machine["supportedPoseContracts"] == []
