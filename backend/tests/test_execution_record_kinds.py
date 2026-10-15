import asyncio
from types import SimpleNamespace

import pytest

from backend import main_import as api
from backend.tests.test_cgiserver_import_regression import FakeRequest


def classify(codes=(), words=None, variable=None, count=1, prior="G0", changed=None):
    start = {"X1": 8.5, "Z1": -1, "B1": 0, "C1": 180}
    end = {**start, "C1": 0, **(changed or {})}
    node = SimpleNamespace(
        g_code=set(codes), command_parameter=words or {},
        variable_command=variable, nc_code_line_nr=2, execution_step=1,
    )
    history = [SimpleNamespace(g_code={prior}), node]
    control = SimpleNamespace(_canals={1: SimpleNamespace(_exec_sequence=history, _tool_nodes=[node])})
    segment = {
        "executionStep": 1, "lineNumber": 2, "points": [{"x": 8.5, "y": 0, "z": -1}] * count,
        "motionContext": {"startAxes": start, "endAxes": end},
    }
    api.annotate_execution_record_kinds(control, 1, [segment])
    return segment


@pytest.mark.parametrize("codes,words,variable,count", [
    ({"G97"}, {"S": "500", "M": "3"}, None, 1),
    (set(), {"N": "200", "T": "200"}, None, 1),
    (set(), {"Z": "0", "S": "3000", "M": "3", "T": "2"}, None, 1),
    ({"G0"}, {"X": "8", "M": "6"}, None, 3),
    ({"G266"}, {}, None, 1),
    (set(), {}, "#100=2", 4),
])
def test_verified_engine_commands_are_state_regardless_of_samples(codes, words, variable, count):
    assert classify(codes, words, variable, count)["recordKind"] == "state"


@pytest.mark.parametrize("kwargs", [
    {"codes": {"G1"}, "words": {"M": "3", "X": "0"}},
    {"words": {"M": "3", "X": "0"}, "prior": "G1"},
    {"words": {"M": "3", "X": "0"}, "prior": "G83"},
    {"words": {"M": "3", "Q": "2"}},
    {"codes": {"G300"}},
    {"codes": {"G125"}},
    {"codes": {"G83"}, "words": {"Z": "20", "Q": "3000"}},
    {"codes": {"G266", "G1"}},
    {"codes": {"G266"}, "words": {"X": "1"}},
    {"words": {"M": "300"}},
    {"words": {"M": "3"}, "changed": {"Z1": 0}},
    {"words": {"M": "3"}, "changed": {"C1": float("nan")}},
    {"variable": "#100=2", "words": {"X": "0"}},
    {"codes": {"G0"}, "words": {"X": "8"}},
])
def test_unverified_or_potential_cutting_commands_remain_unknown(kwargs):
    assert classify(**kwargs)["recordKind"] == "unknown"


def test_stationary_feed_semantics_are_never_reclassified():
    node = SimpleNamespace(g_code={"G1"}, command_parameter={}, execution_step=0, nc_code_line_nr=1)
    control = SimpleNamespace(_canals={1: SimpleNamespace(_exec_sequence=[node], _tool_nodes=[node])})
    segment = {
        "executionStep": 0, "lineNumber": 1, "geometry": "LINEAR", "traversal": "FEED",
        "sourceCode": "G01", "points": [{"x": 1, "y": 0, "z": 0}] * 2,
    }
    api.annotate_execution_record_kinds(control, 1, [segment])
    assert segment["recordKind"] == "motion"


@pytest.mark.parametrize("line,step,context", [
    (2, True, {"startAxes": {"X": 0}, "endAxes": {"X": 0}}),
    (9, 0, {"startAxes": {"X": 0}, "endAxes": {"X": 0}}),
    (2, 0, None),
    (2, 0, {"startAxes": {}, "endAxes": {}}),
])
def test_invalid_occurrence_alignment_or_context_is_not_certified(line, step, context):
    node = SimpleNamespace(
        g_code={"G97"}, command_parameter={"M": "3"}, variable_command=None,
        execution_step=0, nc_code_line_nr=2,
    )
    control = SimpleNamespace(_canals={1: SimpleNamespace(_exec_sequence=[node], _tool_nodes=[node])})
    segment = {"executionStep": step, "lineNumber": line, "motionContext": context}
    api.annotate_execution_record_kinds(control, 1, [segment])
    assert segment["recordKind"] == "unknown"


def test_real_star_spindle_tool_resets_and_feeds_keep_occurrences():
    program = "\n".join([
        "G0 X25 Z-1", "T200", "G97 S500 M3", "Z0 S3000 M3 T2",
        "G1 X0 F0.05", "G1 Z-0.5", "G0 X17", "M36 S2000",
        "#100=2", "#101=0", "WHILE[#101LT#100]DO1",
        "G0 X8 M6", "G1 Y10 F200", "#101=#101+1", "END1",
    ])
    response = asyncio.run(api.cgiserver_import(FakeRequest({
        "toolPathMode": "center",
        "machinedata": [{"machineName": "FANUC_STAR_SR20R_IV_B", "canalNr": "1",
                         "program": program, "toolValues": [{"toolNumber": 200, "qValue": 3, "rValue": .2}]}],
    })))
    assert response["success"], response
    channel = response["canal"]["1"]
    for line in [2, 3, 4, 12]:
        records = [segment for segment in channel["segments"] if segment["lineNumber"] == line]
        assert records
        assert all(record["recordKind"] == "state" for record in records)
    feeds = [segment for segment in channel["segments"] if segment["traversal"] == "FEED"]
    assert feeds and all(segment["recordKind"] == "motion" for segment in feeds)
    repeats = [item for item in channel["executionOccurrences"] if item["lineNumber"] == 12]
    assert len(repeats) == 2
    assert repeats[0]["executionStep"] != repeats[1]["executionStep"]
