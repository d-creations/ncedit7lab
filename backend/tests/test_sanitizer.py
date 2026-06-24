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


def test_strip_parentheses_disabled():
    # Parentheses stripping is disabled because Siemens uses them for parameters
    program = "G1 X10 (this is a comment) Y20"
    sanitized = mi.sanitize_program(program)
    assert "(" in sanitized and ")" in sanitized


def test_semicolon_split():
    program = "G1 X10;G1 Y20"
    sanitized = mi.sanitize_program(program)
    assert "G1 X10" in sanitized
    assert "G1 Y20" in sanitized

def test_variable_assignment_preservation():
    # Make sure we don't treat variables starting with axis letters as axes!
    program = "Z_POS = Z_POS - ZINKREMENT"
    sanitized = mi.sanitize_program(program)
    assert "Z_POS = Z_POS - ZINKREMENT" in sanitized

    program2 = "DEF REAL ENDZ = 10"
    sanitized2 = mi.sanitize_program(program2)
    assert "ENDZ = 10" in sanitized2 or "DEF REAL ENDZ = 10" in sanitized2

