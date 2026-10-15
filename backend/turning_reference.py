"""Normalize the engine's compensated nose-center output, not its toolpath."""
import math
from copy import deepcopy


Q_VECTORS = {
    0: (0, 0), 1: (-1, -1), 2: (1, -1), 3: (1, 1), 4: (-1, 1),
    5: (0, -1), 6: (1, 0), 7: (0, 1), 8: (-1, 0), 9: (0, 0),
}


def engine_pose_request(request):
    """Keep adapter-owned physical geometry out of the engine's strict schema."""
    from ncplot7py.domain.simulation_contract import SimulationContractError

    normalized = deepcopy(request)
    if not isinstance(normalized, dict):
        return normalized
    entries = normalized.get("machinedata", [])
    if not isinstance(entries, list):
        return normalized
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        simulation = entry.get("simulation")
        if not isinstance(simulation, dict) or not isinstance(simulation.get("tools"), list):
            continue
        for tool in simulation["tools"]:
            if not isinstance(tool, dict) or "turningNoseRadius" not in tool:
                continue
            nose = tool.pop("turningNoseRadius")
            if (tool.get("reference") != "turningVirtualTip"
                    or type(nose) not in (int, float) or not math.isfinite(nose) or not 0 <= nose <= 1000):
                raise SimulationContractError(
                    "POSE_REQUEST_INVALID", "turningNoseRadius must be a finite turning radius in [0, 1000]",
                    str(entry.get("canalNr")),
                )
            position = tool.pop("turningTipPosition", [0, 0, 0])
            q = tool.pop("turningTipOrientation", None)
            if (not isinstance(position, list) or len(position) != 3
                    or any(type(v) not in (int, float) or not math.isfinite(v) or abs(v) > 10000 for v in position)
                    or (q is not None and (type(q) is not int or q not in Q_VECTORS))):
                raise SimulationContractError("POSE_REQUEST_INVALID", "Invalid turning tip geometry reference", str(entry.get("canalNr")))
    return normalized


def resolve_turning_references(control, channel, segments, request, machine_name):
    """Certify only aligned, executed G18 STAR center paths.

    The engine already offsets/join polylines and applies machine-space Q/R.
    Its pose projector copies that nose center and supplies the assembly
    quaternion. Subtract the mounted physical nose offset so the existing
    insert model puts its nose back at that center exactly once.
    """
    if request.get("toolPathMode") != "center" or not machine_name.startswith("FANUC_STAR"):
        return
    canals = getattr(control, "_canals", {})
    history = getattr(canals.get(channel), "_exec_sequence", None)
    if not isinstance(history, list):
        return
    state = control.get_nc_state(channel) if hasattr(control, "get_nc_state") else None
    config = getattr(state, "machine_config", None)
    simulation = getattr(config, "simulation", None)
    if (not isinstance(simulation, dict)
            or simulation.get("modelId") not in {"STAR_SR20R_IV_B", "STAR_SV20R", "STAR_SG42"}
            or getattr(state, "tool_path_mode", None) != "center"):
        return
    tools = request["machinedata"][channel - 1].get("simulation", {}).get("tools", [])
    tools = {tool["toolNumber"]: tool for tool in tools}
    planes = []
    plane = getattr(config, "default_plane", None)
    for node in history:
        codes = {str(code).upper() for code in node.g_code}
        if codes & {"G12.1", "G13.1", "G112", "G113", "G68", "G68.1", "G69"}:
            plane = None
        selected = codes & {"G17", "G18", "G19"}
        if selected:
            plane = next(iter(selected)) if len(selected) == 1 else None
        planes.append(plane)
    for segment in segments:
        context = segment.get("motionContext") or {}
        offset = context.get("toolOffset") or {}
        mode = offset.get("radiusMode")
        if segment.get("machiningMode") != "turning" or mode not in ("OFF", "LEFT", "RIGHT") or segment.get("recordKind") == "state":
            continue
        step = segment.get("executionStep")
        if type(step) is not int or not 0 <= step < len(history) or planes[step] != "G18":
            continue
        if history[step].nc_code_line_nr != segment.get("lineNumber"):
            continue
        tool = tools.get(segment.get("toolNumber"), {})
        nose = tool.get("turningNoseRadius")
        position = tool.get("turningTipPosition", [0, 0, 0])
        radius = offset.get("radius", 0) if mode != "OFF" else 0
        q = offset.get("tipOrientation", tool.get("turningTipOrientation")) if radius == 0 else offset.get("tipOrientation")
        if (type(nose) not in (float, int) or not math.isfinite(nose) or nose < 0
                or type(radius) not in (float, int) or not math.isfinite(radius) or radius < 0
                or type(q) is not int or q not in Q_VECTORS
                or not isinstance(position, list) or len(position) != 3
                or any(type(v) not in (int, float) or not math.isfinite(v) for v in position)
                or tool.get("reference") != "turningVirtualTip"):
            continue
        points, poses = segment.get("points"), segment.get("poses")
        if not isinstance(points, list) or not isinstance(poses, list) or len(poses) != len(points) or len(points) < 2:
            continue
        if any(
            pose.get("reference") != "turningVirtualTip"
            or pose.get("position") != [point.get(axis) for axis in ("x", "y", "z")]
            or len(pose.get("orientation", [])) != 4
            or not all(type(v) in (int, float) and math.isfinite(v) for v in [*pose["position"], *pose["orientation"]])
            or abs(math.hypot(*pose["orientation"]) - 1) > 1e-6
            for point, pose in zip(points, poses)
        ):
            continue
        normalized = []
        for pose in poses:
            # Register R controls the path; the physical radius controls mesh registration.
            x, z = Q_VECTORS[q]
            vx, vy, vz = position[0] + x * nose, position[1], position[2] + z * nose
            qx, qy, qz, qw = pose["orientation"]
            tx, ty, tz = 2 * (qy * vz - qz * vy), 2 * (qz * vx - qx * vz), 2 * (qx * vy - qy * vx)
            mounted = (
                vx + qw * tx + qy * tz - qz * ty,
                vy + qw * ty + qz * tx - qx * tz,
                vz + qw * tz + qx * ty - qy * tx,
            )
            normalized.append({
                **pose,
                "position": [
                    value + virtual_shift - shift
                    for value, virtual_shift, shift in zip(
                        pose["position"], (0, 0, 0) if radius > 0 else (x * nose, 0, z * nose), mounted,
                    )
                ],
                "turningReference": {
                    "kind": "resolved-center-path-v1", "noseRadius": nose,
                    "tipPosition": list(position),
                    "tipOrientation": q, "compensationRadius": radius, "radiusMode": mode,
                },
            })
        segment["poses"] = normalized
        if radius == 0 and "tipOrientation" not in offset:
            context["toolOffset"] = {**offset, "tipOrientation": q}
