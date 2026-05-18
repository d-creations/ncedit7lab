import sys
import os

# Add root directory to sys.path to resolve 'backend' imports on Azure
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, Request, HTTPException, Header, Depends
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
import json
import logging
import math
from typing import List, Dict, Any, Optional
import re
import traceback
from pathlib import Path
import importlib.util
from pydantic import BaseModel

# Focas Service
try:
    from backend.focas_service import get_focas_client, get_demo_focas_client, is_demo_ip, FocasClientBase, FocasError
    FOCAS_IMPORT_OK = True
except ImportError:
    try:
        from focas_service import get_focas_client, get_demo_focas_client, is_demo_ip, FocasClientBase, FocasError
        FOCAS_IMPORT_OK = True
    except ImportError as e:
        import logging
        logging.exception(f"Failed to import focas_service: {e}")
        FOCAS_IMPORT_OK = False
        class FocasClientBase: pass
        def get_focas_client(): return None
        def get_demo_focas_client(): return None
        def is_demo_ip(ip_address: str): return False
        class FocasError(Exception): pass

# Simple security: API Key to prevent basic bot requests
API_KEY = os.environ.get("API_KEY", "nc-edit7-secret-key")
ENABLE_FOCAS = os.environ.get("ENABLE_FOCAS", "True").lower() in ("true", "1", "t", "yes")

async def verify_api_key(x_api_key: Optional[str] = Header(None)): return True

# Ensure ncplot7py/src is in sys.path for F1/Code deployment where PYTHONPATH env var might not be set easily
# We assume this file is in backend/main_import.py, and ncplot7py is at ../ncplot7py
try:
    current_dir = Path(__file__).resolve().parent
    package_src = current_dir.parent / "ncplot7py" / "src"
    if package_src.exists() and str(package_src) not in sys.path:
        sys.path.insert(0, str(package_src))
except Exception:
    pass


def resolve_machines_config_path() -> Optional[Path]:
    local_config = ROOT_DIR / "ncplot7py" / "config" / "machines.json"
    if local_config.exists():
        return local_config

    spec = importlib.util.find_spec("ncplot7py")
    if spec is None or spec.origin is None:
        return None

    package_root = Path(spec.origin).resolve().parent
    candidates = [
        package_root / "config" / "machines.json",
        package_root.parent / "config" / "machines.json",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate

    return None

# Import ncplot7py internals
try:
    from ncplot7py.application.nc_execution import NCExecutionEngine
    from ncplot7py.infrastructure.machines.base_stateful_control import UniversalConfigDrivenControl
    from ncplot7py.cli.main import bootstrap as cli_bootstrap
    from ncplot7py.domain.machines import (
        get_available_machines,
        get_machine_regex_patterns,
        get_machine_config,
    )
    from ncplot7py.domain.cnc_state import CNCState
    from ncplot7py.domain.exceptions import ExceptionNode
except Exception as e:
    logging.error(f"Failed to import ncplot7py: {e}")
    logging.error(traceback.format_exc())
    # If package isn't importable in some environments, we will raise at runtime
    NCExecutionEngine = None  # type: ignore
    UniversalConfigDrivenControl = None  # type: ignore
    cli_bootstrap = None  # type: ignore
    get_available_machines = None # type: ignore
    get_machine_regex_patterns = None # type: ignore
    CNCState = None  # type: ignore
    ExceptionNode = None  # type: ignore

app = FastAPI(title="ncplot7py-adapter-import")

# Security: Trusted Host Middleware
# Prevents Host Header attacks. In Azure, this should be set to your domain (e.g., "nc-edit7.azurewebsites.net").
# For development, "*" is acceptable.
app.add_middleware(
    TrustedHostMiddleware, 
    allowed_hosts=os.environ.get("ALLOWED_HOSTS", "*").split(",")
)

# Security: CORS
# Restrict origins in production using ALLOWED_ORIGINS env var.
_allowed_origins_env = os.environ.get("ALLOWED_ORIGINS", "").strip()
if _allowed_origins_env == "*":
    allowed_origins = ["*"]
    logging.warning("ALLOWED_ORIGINS='*' — allowing all origins. Unsafe for production.")
elif _allowed_origins_env:
    allowed_origins = [o.strip() for o in _allowed_origins_env.split(",") if o.strip()]
else:
    allowed_origins = []
    logging.info("ALLOWED_ORIGINS not set — CORS will not allow cross-origin requests. Use this in production or set explicit origins for development.")

_allow_credentials = os.environ.get("ALLOW_CREDENTIALS", "True").lower() in ("true", "1", "t", "yes")
if "*" in allowed_origins and _allow_credentials:
    logging.warning("CORS: allow_credentials=True with '*' origin may be rejected by browsers. Specify explicit origins or set ALLOW_CREDENTIALS=False.")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Security: HTTP Headers
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    # Prevent MIME sniffing
    response.headers["X-Content-Type-Options"] = "nosniff"
    # Clickjacking protection / iframe embedding
    #
    # Default: deny framing.
    # If you need to embed this app in an <iframe>, set FRAME_ANCESTORS, e.g.:
    #   FRAME_ANCESTORS="https://www.star-ncplot.com"
    #
    # Prefer CSP `frame-ancestors` (modern). X-Frame-Options does not support
    # allowing specific external origins reliably across browsers.
    frame_ancestors = os.environ.get("FRAME_ANCESTORS", "").strip()
    if frame_ancestors:
        new_fa = f"frame-ancestors {frame_ancestors};"
        existing_csp = response.headers.get("Content-Security-Policy")
        if existing_csp:
            if "frame-ancestors" in existing_csp:
                response.headers["Content-Security-Policy"] = re.sub(
                    r"frame-ancestors[^;]*;?",
                    new_fa,
                    existing_csp,
                    flags=re.IGNORECASE,
                ).strip()
            else:
                response.headers["Content-Security-Policy"] = f"{existing_csp.rstrip()}; {new_fa}".strip()
        else:
            response.headers["Content-Security-Policy"] = new_fa

        # Ensure we don't block framing via X-Frame-Options.
        if "X-Frame-Options" in response.headers:
            del response.headers["X-Frame-Options"]
    else:
        response.headers["X-Frame-Options"] = "DENY"
    # Enable XSS protection in older browsers
    response.headers["X-XSS-Protection"] = "1; mode=block"
    # Enforce HTTPS (HSTS) - 1 year
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    # Referrer Policy
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

logging.basicConfig(level=logging.INFO)


def apply_turn_axis_defaults(states: List[Optional[Any]], machine_name: str = "") -> None:
    from ncplot7py.domain.machines import get_machine_config
    config = get_machine_config(machine_name)
    
    for state in states:
        if state is None:
            continue
        try:
            for axis in config.diameter_axes:
                if state.get_axis_unit(axis).lower() == "radius":
                    state.set_axis_unit(axis, "diameter")
        except Exception:
            continue

# Serve frontend static files (production build) if available.
from pathlib import Path
import os

ROOT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIRS = [ROOT_DIR / "dist", ROOT_DIR / "public", ROOT_DIR]
STATIC_DIR = None
for d in FRONTEND_DIRS:
    index_path = d / "index.html"
    if index_path.exists():
        STATIC_DIR = d
        break

if STATIC_DIR is not None:
    # Mount only asset directories to avoid shadowing API POST routes.
    # The built Vite app places hashed assets under `assets/`.
    assets_dir = STATIC_DIR / "assets"
    favicon_dir = STATIC_DIR / "favicon"
    images_dir = STATIC_DIR / "images"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")
    if favicon_dir.exists():
        app.mount("/favicon", StaticFiles(directory=str(favicon_dir)), name="favicon")
    if images_dir.exists():
        app.mount("/images", StaticFiles(directory=str(images_dir)), name="images")

    # Expose other top-level static files (like favicon) under /static
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
    # Note: the index route (`/`) will return index.html explicitly.


@app.get("/config.json")
async def config_json():
    if STATIC_DIR is not None:
        config_file = STATIC_DIR / "config.json"
        if config_file.exists():
            return FileResponse(str(config_file), media_type="application/json")
    raise HTTPException(status_code=404, detail="config.json not found")


@app.get("/favicon.svg")
async def favicon_svg():
    return RedirectResponse(url="/favicon/favicon.svg", status_code=307)


@app.get("/favicon.ico")
async def favicon_ico():
    return RedirectResponse(url="/favicon/favicon.svg", status_code=307)


@app.get("/api/syntax/{control_type}")
async def get_syntax(control_type: str):
    """Endpoint providing ACE Editor syntax highlights dynamically by reading machines.json directly."""
    config_path = resolve_machines_config_path()
    
    rules = []
    
    try:
        if config_path is not None and config_path.exists():
            with open(config_path, "r") as f:
                machines_data = json.load(f)
                
            # Scan for the first config matching the control_type to get its syntax_rules
            for key, config in machines_data.items():
                if isinstance(config, dict) and config.get("control_type", "").upper() == control_type.upper():
                    rules = config.get("syntax_rules", [])
                    break
    except Exception as e:
        logging.error(f"Failed to read machines.json for syntax endpoint: {e}")

    # Fallback if no rules found for the control type
    if not rules:
        rules = [
            {"token": "comment.line.modifier", "regex": "^\\s*\\/.*"},
            {"token": "comment", "regex": "\\([^)]*\\)"},
            {"token": "string.quoted.double", "regex": "\"[^\"]*\""},
            {"token": "keyword.control", "regex": "\\b(?:GOTO|IF|WHILE|DO|END)\\b"},
            {"token": "support.function", "regex": "\\b(?:SQRT|ASIN|ACOS|ATAN|SIN|COS|TAN|ABS|BIN|BCD|ROUND|FIX|FUP)\\b"},
            {"token": "keyword.operator", "regex": "[\\+\\-\\*\\/=]"},
            {"token": "variable.parameter", "regex": "#(\\d+)"},
            {"token": "constant.language.gcode", "regex": "[Gg]\\s*\\d+(?:\\.\\d+)?"},
            {"token": "constant.language.mcode", "regex": "[Mm]\\s*\\d+(?:\\.\\d+)?"},
            {"token": ["entity.name.tag", "constant.numeric"], "regex": "([A-Z])(\\s*[+-]?\\d+(?:\\.\\d+)?)"}
        ]
        
    return {"status": "success", "control_type": control_type.upper(), "rules": rules}


def list_machines() -> Dict[str, Any]:
    if get_available_machines is None:
        return {"machines": [], "success": False, "message": "ncplot7py not available"}

    machines = get_available_machines()

    # Add regex patterns to each machine
    for machine in machines:
        if get_machine_regex_patterns:
            machine["regexPatterns"] = get_machine_regex_patterns(machine["controlType"])
        config = get_machine_config(machine["machineName"])
        machine["variablePrefix"] = config.variable_prefix

    return {
        "machines": machines,
        "success": True,
    }


@app.get("/api/machines")
async def api_machines():
    return list_machines()


def build_segments_from_engine_output(canal_output: Dict[str, Any]) -> Dict[str, Any]:
    """Convert NCExecutionEngine canal output to the legacy response shape."""
    segments = []
    timing = []
    executed_lines = canal_output.get("programExec", [])
    variables = canal_output.get("variables", {})

    plot_list = canal_output.get("plot", [])

    for idx, entry in enumerate(plot_list):
        x = entry.get("x", [])
        y = entry.get("y", [])
        z = entry.get("z", [])
        t = entry.get("t", 0)

        if len(x) == 0:
            continue

        points = []
        point_count = max(len(x), len(y), len(z))
        for point_idx in range(point_count):
            points.append({
                "x": x[point_idx] if point_idx < len(x) else (x[-1] if len(x) > 0 else 0),
                "y": y[point_idx] if point_idx < len(y) else (y[-1] if len(y) > 0 else 0),
                "z": z[point_idx] if point_idx < len(z) else (z[-1] if len(z) > 0 else 0),
            })

        seg = {
            "type": "RAPID" if (not t or float(t) == 0) else "LINEAR",
            "lineNumber": entry.get("lineNumber", executed_lines[idx] if idx < len(executed_lines) else None),
            "toolNumber": 1,
            "points": points,
        }
        segments.append(seg)
        try:
            timing.append(float(t))
        except Exception:
            timing.append(0.0)

    return {
        "segments": segments,
        "executedLines": executed_lines,
        "variables": variables if isinstance(variables, dict) else {},
        "timing": timing,
    }


@app.get("/")
async def index():
    """Return the frontend `index.html` when available, otherwise a JSON status.

    If the environment variable `FRONTEND_URL` is set (for dev), redirect there.
    """
    # If static files were mounted, StaticFiles will already serve index.html.
    if STATIC_DIR is not None:
        index_file = STATIC_DIR / "index.html"
        if index_file.exists():
            return FileResponse(str(index_file), media_type="text/html")

    # Dev fallback: redirect to dev server if configured
    frontend_url = os.environ.get("FRONTEND_URL")
    if frontend_url:
        return RedirectResponse(frontend_url)

    return {"service": "ncplot7py-adapter-import", "status": "ok", "note": "No frontend build found"}


def sanitize_program(program: str) -> str:
    """Conservative sanitizer exposed at module level for reuse and testing.

    - Removes parenthetical comments ("(comment)").
    - Splits lines by semicolon `;` into sub-commands and processes each
      sub-command separately.
    - In each sub-command removes duplicate axis tokens (X/Y/Z/I/J/K),
      keeping the last occurrence so explicit later overrides win.
    - Preserves other tokens and reassembles semicolon-separated commands.
    """
    if not isinstance(program, str):
        return program

    # Remove parenthetical comments (single-line)
    # DISABLED: Siemens uses () for parameters (e.g. CYCLE800(...))
    # program = re.sub(r"\(.*?\)", "", program)
    # We should only remove comments if we are sure they are comments.
    # For now, let the parser handle comments.

    def sanitize_subcmd(sub: str) -> str:
        parts = [p for p in sub.strip().split() if p != ""]
        axis_re = re.compile(r'^([XYZIJKxyzijk])')
        last_axis = {}
        others = []
        # record last index for axis tokens and keep others with position
        for i, p in enumerate(parts):
            m = axis_re.match(p)
            if m:
                last_axis[m.group(1).upper()] = i
            else:
                others.append((i, p))

        if not last_axis and not others:
            return sub.strip()

        axis_by_index = {idx: parts[idx] for idx in last_axis.values()}

        merged = []
        for i in range(len(parts)):
            if i in axis_by_index:
                merged.append(axis_by_index[i])
            else:
                # append any other token at this position
                for pos, val in others:
                    if pos == i:
                        merged.append(val)
                        break

        return " ".join(merged)

    sanitized_lines = []
    for line in program.splitlines():
        # split by semicolon but keep semantic separators
        subs = [s for s in line.split(";")]
        san_subs = [sanitize_subcmd(s) for s in subs]
        sanitized_lines.append(";".join([s for s in san_subs if s is not None]))

    return "\n".join(sanitized_lines)


def mock_parse_nc_program(program: str, machine_name: str) -> Dict[str, Any]:
    """
    Parse NC program and generate mock plot data (legacy behavior).
    Copied from ncplot7py/scripts/cgiserver.cgi to ensure compatibility.
    """
    lines = [line.strip() for line in program.split('\n') if line.strip()]

    # Generate mock plot segments
    segments = []

    # Track programmed coordinates separately from plotted world coordinates.
    # C rotates the coordinate system around Z, so local X/Y stay unchanged
    # while the plotted point is transformed by the current C angle.
    current_local = {"x": 0.0, "y": 0.0, "z": 0.0, "c": 0.0}

    def to_plot_point(local_pos: Dict[str, float]) -> Dict[str, float]:
        angle_rad = math.radians(local_pos["c"])
        x = local_pos["x"] * math.cos(angle_rad) - local_pos["y"] * math.sin(angle_rad)
        y = local_pos["x"] * math.sin(angle_rad) + local_pos["y"] * math.cos(angle_rad)
        return {"x": x, "y": y, "z": local_pos["z"]}
    
    for i, line in enumerate(lines):
        # Simple G-code parsing for demo
        if line.startswith('G0') or line.startswith('G1'):
            # Extract coordinates in programmed space
            new_local = current_local.copy()

            parts = line.split()
            for part in parts:
                if part.startswith('X'):
                    try:
                        new_local['x'] = float(part[1:])
                    except ValueError:
                        pass
                elif part.startswith('Y'):
                    try:
                        new_local['y'] = float(part[1:])
                    except ValueError:
                        pass
                elif part.startswith('Z'):
                    try:
                        new_local['z'] = float(part[1:])
                    except ValueError:
                        pass
                elif part.startswith('C'):
                    try:
                        new_local['c'] = float(part[1:])
                    except ValueError:
                        pass
                elif part.startswith('H'):
                    try:
                        new_local['c'] += float(part[1:])
                    except ValueError:
                        pass

            delta_c = new_local['c'] - current_local['c']
            segment_count = 1
            if abs(delta_c) > 1e-9:
                segment_count = max(2, int(math.ceil(abs(delta_c) / 10.0)))

            points = []
            for step in range(segment_count + 1):
                t = step / segment_count
                interpolated_local = {
                    'x': current_local['x'] + (new_local['x'] - current_local['x']) * t,
                    'y': current_local['y'] + (new_local['y'] - current_local['y']) * t,
                    'z': current_local['z'] + (new_local['z'] - current_local['z']) * t,
                    'c': current_local['c'] + delta_c * t,
                }
                points.append(to_plot_point(interpolated_local))

            # Create segment
            segment = {
                "type": "RAPID" if line.startswith('G0') else "LINEAR",
                "lineNumber": i + 1,
                "toolNumber": 1,
                "points": points,
            }
            segments.append(segment)
            current_local = new_local
    
    return {
        "segments": segments,
        "executedLines": list(range(1, len(lines) + 1)),
        "variables": {},
        "timing": [0.1] * len(lines)
    }


def run_mock_parser(machinedata: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Run the mock parser for all programs in machinedata."""
    canal_results = {}
    messages = []
    
    for program_entry in machinedata:
        program = program_entry.get("program", "")
        machine_name = program_entry.get("machineName", "SIEMENS_MILL")
        canal_nr = str(program_entry.get("canalNr", "1"))
        
        # Parse program
        try:
            result = mock_parse_nc_program(program, machine_name)
            canal_results[canal_nr] = result
            messages.append(f"Successfully processed {machine_name} canal {canal_nr} (mock)")
        except Exception as e:
            messages.append(f"Error processing {machine_name} canal {canal_nr}: {str(e)}")
    
    return {
        "canal": canal_results,
        "message": messages,
        "success": True
    }


@app.post("/cgiserver_import", dependencies=[Depends(verify_api_key)])
async def cgiserver_import(request: Request):
    if NCExecutionEngine is None or UniversalConfigDrivenControl is None:
        logging.warning("ncplot7py package not importable in this environment; some actions will be limited")

    # Log incoming request path and headers for debugging proxy issues
    try:
        raw_body = await request.body()
        logging.info("Incoming request: %s %s", request.method, request.url.path)
        # Log a trimmed version of headers and body to avoid huge logs
        headers_preview = {k: v for k, v in list(request.headers.items())[:10]}
        logging.info("Headers (preview): %s", headers_preview)
        logging.info("Body (raw preview): %s", raw_body[:1000])
        # Parse JSON from raw body
        try:
            req = json.loads(raw_body.decode("utf-8") if raw_body else "{}")
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON request body")
    except Exception:
        raise HTTPException(status_code=400, detail="Unable to read request body")

    # Ensure parser registration
    try:
        if cli_bootstrap:
            cli_bootstrap()
    except Exception:
        logging.exception("Bootstrap failed")

    # Handle actions
    if isinstance(req, dict) and "action" in req:
        action = req.get("action")
        if action in ["list_machines", "get_machines"]:
            return list_machines()
        else:
            raise HTTPException(status_code=400, detail=f"Unknown action: {action}")

    # Handle machinedata
    machinedata = None
    if isinstance(req, dict) and "machinedata" in req:
        machinedata = req.get("machinedata")
    elif isinstance(req, list):
        machinedata = req
    else:
        raise HTTPException(status_code=400, detail="Invalid request format")

    # Build programs list, canal names, tool values, custom variables, and machine names
    programs: List[str] = []
    canal_names: List[str] = []
    tool_values_list: List[List[Dict[str, Any]]] = []
    custom_variables_list: List[List[Dict[str, Any]]] = []
    machine_names: List[str] = []
    # use module-level `sanitize_program` defined above

    for entry in machinedata:
        prog = entry.get("program", "")
        prog_sanitized = sanitize_program(prog)
        programs.append(prog_sanitized)
        canal_names.append(str(entry.get("canalNr", "1")))
        machine_names.append(str(entry.get("machineName", "SIEMENS_MILL")))
        
        # Extract toolValues (Q quadrant 1-9 and R radius for tool compensation)
        tool_values = entry.get("toolValues", [])
        tool_values_list.append(tool_values)
        logging.info(f"Tool values for canal {entry.get('canalNr', '1')}: {tool_values}")
        
        # Extract customVariables (user-defined variables)
        custom_vars = entry.get("customVariables", [])
        custom_variables_list.append(custom_vars)
        logging.info(f"Custom variables for canal {entry.get('canalNr', '1')}: {custom_vars}")

    # Create initial CNC states with custom variables and tool data
    init_states = []
    for idx in range(len(programs)):
        if CNCState is not None:
            state = CNCState()
            machine_name = machine_names[idx] if idx < len(machine_names) else ""
            if machine_name:
                try:
                    state.machine_config = get_machine_config(machine_name)
                except Exception:
                    logging.warning("Failed to load machine config for %s", machine_name)

            # Set custom variables into state parameters
            custom_vars = custom_variables_list[idx] if idx < len(custom_variables_list) else []
            for var in custom_vars:
                var_name = str(var.get("name", ""))
                var_value = var.get("value", 0)
                if var_name:
                    try:
                        state.set_parameter(var_name, float(var_value))
                    except (ValueError, TypeError):
                        logging.warning(f"Invalid custom variable value: {var_name}={var_value}")
            
            # Store tool Q/R values in state extra for later use by tool compensation handlers
            tool_vals = tool_values_list[idx] if idx < len(tool_values_list) else []
            tool_data = {}
            for tv in tool_vals:
                t_num = tv.get("toolNumber")
                if t_num is not None:
                    try:
                        key = int(t_num)
                    except ValueError:
                        key = str(t_num)

                    tool_data[key] = {
                        "qValue": tv.get("qValue"),  # Quadrant Q1-Q9
                        "rValue": tv.get("rValue"),  # Tool radius R
                    }
            state.extra["tool_compensation_data"] = tool_data
            init_states.append(state)
        else:
            init_states.append(None)

    # Determine control type based on machine name
    # Default to SIEMENS_MILL (Siemens-style) when no machine is specified
    first_machine = machine_names[0] if machine_names else ""
    is_siemens_mill = "SIEMENS" in first_machine.upper()
    is_fanuc_mill = "FANUC_MILL" in first_machine.upper()
    
    # If no machine specified, default to Siemens mill
    if not first_machine:
        is_siemens_mill = True

    if not is_siemens_mill and not is_fanuc_mill:
        apply_turn_axis_defaults(init_states, first_machine)

    # Create a control that can handle multiple canals and run the engine.
    engine_output = None
    errors: List[Dict[str, Any]] = []
    try:
        # Choose control type based on machine
        control = UniversalConfigDrivenControl(
            count_of_canals=len(programs), 
            canal_names=canal_names,
            init_nc_states=init_states if any(s is not None for s in init_states) else None
        )
        engine = NCExecutionEngine(control)
        engine_output = engine.get_Syncro_plot(programs, False)
        
        # Collect any errors from the engine
        errors = getattr(engine, 'errors', [])
    except ExceptionNode as e:
        # Handle structured NC errors
        error_info = {
            "type": e.typ.name if hasattr(e.typ, 'name') else str(e.typ),
            "code": e.code,
            "line": e.line,
            "message": e.localized("en"),
            "value": str(e.value) if e.value else "",
        }
        errors.append(error_info)
        logging.warning("NC execution error: %s", error_info)
    except Exception as e:
        logging.warning("Real engine failed: %s. Falling back to mock parser.", e)
        # Fallback will handle this

    # Check if engine output is valid/non-empty. If empty or failed, use mock.
    use_mock = False
    if engine_output is None:
        use_mock = True
    else:
        # Check if we got any plot points. If all canals are empty, assume failure/mismatch
        # and fallback to mock (legacy behavior) to ensure the user sees something.
        total_points = 0
        for canal in engine_output:
            if isinstance(canal, dict):
                total_points += len(canal.get("plot", []))
            elif isinstance(canal, list):
                total_points += len(canal)
        
        if total_points == 0 and any(len(p.strip()) > 0 for p in programs):
            logging.info("Real engine returned 0 points for non-empty program. Falling back to mock.")
            use_mock = True

    if use_mock:
        result = run_mock_parser(machinedata)
        # Include any errors that occurred before falling back to mock
        if errors:
            result["errors"] = errors
        return result

    # engine_output is a list per canal
    canal_results = {}
    messages = []
    for idx, canal in enumerate(engine_output):
        canal_nr = canal_names[idx] if idx < len(canal_names) else str(idx + 1)
        try:
            # The engine is expected to return a dict per canal. In some
            # situations it may return a raw list (plot points) — normalize
            # that to the expected dict shape to avoid attribute errors.
            if isinstance(canal, list):
                logging.info("Normalizing canal output: list -> dict (plot)")
                canal = {"plot": canal, "programExec": []}

            converted = build_segments_from_engine_output(canal)
            canal_results[canal_nr] = converted
            messages.append(f"Successfully processed canal {canal_nr}")
        except Exception as e:
            logging.exception("Failed converting canal output for canal %s", canal_nr)
            # Return a structured response instead of letting FastAPI raise 500
            return {
                "canal": canal_results,
                "message": [f"Conversion error for canal {canal_nr}: {str(e)}", f"raw_output: {repr(canal)[:1000]}"],
                "success": False,
                "errors": errors,
            }

    response = {"canal": canal_results, "message": messages, "success": True}
    # Include errors array in the response even if execution succeeded partially
    if errors:
        response["errors"] = errors
        # Keep success=True for partial results, add hasErrors flag for clarity
        response["hasErrors"] = True
    return response


# Backwards-compatible legacy CGI path used by the frontend
@app.api_route("/ncplot7py/scripts/cgiserver.cgi", methods=["POST", "OPTIONS", "GET"])
async def legacy_cgiserver(request: Request):
    """Legacy endpoint to keep compatibility with frontends that post to
    `/ncplot7py/scripts/cgiserver.cgi`. POST requests are forwarded to the
    import adapter handler. GET returns the frontend index or a small JSON
    status so browsers don't receive Method Not Allowed or 404 errors.
    """
    # Handle preflight
    if request.method == "OPTIONS":
        return {"status": "ok"}

    if request.method == "GET":
        # Return index.html when available (same behavior as root)
        if STATIC_DIR is not None:
            index_file = STATIC_DIR / "index.html"
            if index_file.exists():
                return FileResponse(str(index_file), media_type="text/html")
        frontend_url = os.environ.get("FRONTEND_URL")
        if frontend_url:
            return RedirectResponse(frontend_url)
        return {"service": "ncplot7py-adapter-import", "status": "ok"}

    # For POST, reuse the cgiserver_import handler to process the body.
    # Manually verify API key for legacy endpoint since it handles multiple methods
    if request.method == "POST":
        x_api_key = request.headers.get("X-API-Key")
        if x_api_key != API_KEY:
             raise HTTPException(status_code=403, detail="Invalid or missing API Key")

    try:
        return await cgiserver_import(request)
    except HTTPException:
        # Re-raise HTTPExceptions so status codes are preserved
        raise
    except Exception:
        logging.exception("Unhandled error in legacy_cgiserver")
        raise HTTPException(status_code=500, detail="Internal server error")

# --- Features Endpoint ---

@app.get("/api/features")
async def get_features():
    """Endpoint for frontend to query which backend modules are available."""
    return {
        "focas_enabled": ENABLE_FOCAS and FOCAS_IMPORT_OK,
        "cgi_path": ""  # Only relevant for main.py subprocess
    }

# --- FOCAS API Routes ---

class FocasConnection(BaseModel):
    ip_address: str
    port: int = 8193
    timeout: int = 10

class FocasDownloadData(BaseModel):
    program_text: str

@app.get("/api/focas/ping")
async def focas_ping(ip_address: str):
    if not ENABLE_FOCAS:
        raise HTTPException(status_code=501, detail="FOCAS support is disabled on this server.")
    
    import platform
    import asyncio
    
    is_windows = platform.system().lower() == "windows"
    param_count = "-n" if is_windows else "-c"
    param_wait = "-w" if is_windows else "-W"
    wait_val = "1000" if is_windows else "1"
    
    try:
        process = await asyncio.create_subprocess_exec(
            "ping", param_count, "1", param_wait, wait_val, ip_address,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        await process.communicate()
        return {"status": "success", "available": process.returncode == 0}
    except Exception as e:
        return {"status": "success", "available": False, "error": str(e)}

@app.post("/api/focas/connect")
async def focas_connect(conn: FocasConnection, client: FocasClientBase = Depends(get_focas_client)):
    if is_demo_ip(conn.ip_address):
        client = get_demo_focas_client()
    elif not ENABLE_FOCAS or not FOCAS_IMPORT_OK:
        raise HTTPException(status_code=501, detail="FOCAS support is disabled.")
    try:
        success = client.connect(conn.ip_address, conn.port, conn.timeout)
        if not success:
            raise HTTPException(status_code=500, detail="Failed to connect to CNC")
        
        client.disconnect()
        return {"status": "success", "message": f"Connected to {conn.ip_address}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/focas/programs/{path_no}")
async def focas_list_programs(path_no: int, ip_address: str, port: int = 8193, client: FocasClientBase = Depends(get_focas_client)):
    if is_demo_ip(ip_address):
        client = get_demo_focas_client()
    elif not ENABLE_FOCAS or not FOCAS_IMPORT_OK:
        raise HTTPException(status_code=501, detail="FOCAS support is disabled.")
    try:
        if not client.connect(ip_address, port):
            raise HTTPException(status_code=500, detail="Failed to connect to CNC")
            
        programs = client.list_programs(path_no)
        return {"status": "success", "programs": programs}
    except FocasError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        client.disconnect()

@app.get("/api/focas/upload/{path_no}/{prog_num}")
async def focas_upload(path_no: int, prog_num: int, ip_address: str, port: int = 8193, client: FocasClientBase = Depends(get_focas_client)):
    if is_demo_ip(ip_address):
        client = get_demo_focas_client()
    elif not ENABLE_FOCAS or not FOCAS_IMPORT_OK:
        raise HTTPException(status_code=501, detail="FOCAS support is disabled.")
    try:
        if not client.connect(ip_address, port):
            raise HTTPException(status_code=500, detail="Failed to connect to CNC before upload")
            
        program_text = client.upload_program(prog_num, path_no)
        return {"status": "success", "program_text": program_text}
    except FocasError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        client.disconnect()

@app.post("/api/focas/download/{path_no}")
async def focas_download(path_no: int, ip_address: str, data: FocasDownloadData, port: int = 8193, client: FocasClientBase = Depends(get_focas_client)):
    if is_demo_ip(ip_address):
        client = get_demo_focas_client()
    elif not ENABLE_FOCAS or not FOCAS_IMPORT_OK:
        raise HTTPException(status_code=501, detail="FOCAS support is disabled.")
    try:
        if not client.connect(ip_address, port):
            raise HTTPException(status_code=500, detail="Failed to connect to CNC before download")
            
        client.download_program(data.program_text, path_no)
        return {"status": "success", "message": "Program successfully downloaded to CNC"}
    except FocasError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        client.disconnect()


