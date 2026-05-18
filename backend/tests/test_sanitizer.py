import re
from backend import main_import as mi


def test_duplicate_axis_removal():
    program = "G1 X10 X20 Y5 Y6 Z0 Z1"
    sanitized = mi.sanitize_program(program)
    parts = re.split(r"[;\n]+", sanitized)
    for p in parts:
        if not p.strip():
            continue
        for axis in ("X", "Y", "Z"):
            matches = re.findall(rf"\b{axis}[-+]?\d+\.?\d*", p)
            assert len(matches) <= 1, f"axis {axis} appears {len(matches)} times in '{p}'"


def test_strip_parentheses():
    program = "G1 X10 (this is a comment) Y20"
    sanitized = mi.sanitize_program(program)
    assert "(" not in sanitized and ")" not in sanitized


def test_semicolon_split():
    program = "G1 X10;G1 Y20"
    sanitized = mi.sanitize_program(program)
    assert "G1 X10" in sanitized
    assert "G1 Y20" in sanitized
