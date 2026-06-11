import asyncio
import json
from types import SimpleNamespace

from backend import main_import as api


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
                "machineName": "SIEMENS_840D",
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