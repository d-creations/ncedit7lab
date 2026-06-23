from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from pydantic import BaseModel
from pathlib import Path
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import importlib.util
import asyncio
import json
import os
import logging
from transfer.interface import TransferError
from transfer.router import router as transfer_router

app = FastAPI(title="ncplot7py-adapter")

if transfer_router:
    app.include_router(transfer_router)

@app.exception_handler(TransferError)
async def transfer_error_handler(request: Request, exc: TransferError):
    print(f"[VSCODE_NOTIFICATION] ERROR: {str(exc)}", flush=True)
    return JSONResponse(status_code=400, content={"detail": str(exc)})

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    # Only pop up VS Code notifications for 5xx errors or explicit 400 bad requests to avoid annoying 404 popups
    if exc.status_code >= 400:
        print(f"[VSCODE_NOTIFICATION] ERROR: {exc.detail}", flush=True)
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    print(f"[VSCODE_NOTIFICATION] ERROR: Internal Server Error: {str(exc)}", flush=True)
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CGI_PATH = os.environ.get("CGI_PATH", "/app/ncplot7py/scripts/cgiserver.cgi")
CGI_TIMEOUT = int(os.environ.get("CGI_TIMEOUT", "30"))

logging.basicConfig(level=logging.INFO)

ROOT_DIR = Path(__file__).resolve().parents[1]


def resolve_machines_config_path() -> Path | None:
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


FRONTEND_DIRS = [ROOT_DIR / "dist", ROOT_DIR / "public", ROOT_DIR]
STATIC_DIR = None
for directory in FRONTEND_DIRS:
    if (directory / "index.html").exists() or directory == ROOT_DIR / "public":
        STATIC_DIR = directory
        break

if STATIC_DIR is not None:
    favicon_dir = STATIC_DIR / "favicon"
    images_dir = STATIC_DIR / "images"
    if favicon_dir.exists():
        app.mount("/favicon", StaticFiles(directory=str(favicon_dir)), name="favicon")
    if images_dir.exists():
        app.mount("/images", StaticFiles(directory=str(images_dir)), name="images")


@app.get("/config.json")
async def config_json():
    if STATIC_DIR is not None:
        config_file = STATIC_DIR / "config.json"
        if config_file.exists():
            return FileResponse(config_file, media_type="application/json")
    raise HTTPException(status_code=404, detail="config.json not found")

@app.get("/templates.json")
async def templates_json():
    if STATIC_DIR is not None:
        templates_file = STATIC_DIR / "templates.json"
        if templates_file.exists():
            return FileResponse(templates_file, media_type="application/json")
    raise HTTPException(status_code=404, detail="templates.json not found")

@app.get("/api/features")
async def get_features():
    """Endpoint for frontend to query which backend modules are available."""
    return {
        "cgi_path": CGI_PATH
    }

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
        logging.error("Failed to read machines.json for syntax endpoint: %s", e)

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

def strip_cgi_headers(output: str) -> str:
    """Strip CGI HTTP headers from output, returning just the body.

    CGI scripts output HTTP headers followed by a blank line, then the body.
    This function extracts just the body content (typically JSON).
    """
    # Split on double newline (blank line separating headers from body)
    parts = output.split("\n\n", 1)
    if len(parts) == 2:
        return parts[1].strip()
    # If no blank line found, try \r\n\r\n (Windows-style)
    parts = output.split("\r\n\r\n", 1)
    if len(parts) == 2:
        return parts[1].strip()
    # No headers found, return original (might already be just JSON)
    return output.strip()


async def run_cgi(input_data: str, timeout: int = CGI_TIMEOUT) -> str:
    """Run the existing CGI script as a subprocess and return stdout as string.

    The CGI is invoked using `python3 <cgi_path>` and receives JSON on stdin.
    Environment variables `REQUEST_METHOD` and `CONTENT_LENGTH` are set.
    """
    env = os.environ.copy()
    env.update({
        "REQUEST_METHOD": "POST",
        "CONTENT_LENGTH": str(len(input_data)),
    })

    proc = await asyncio.create_subprocess_exec(
        "python3",
        CGI_PATH,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(input=input_data.encode("utf-8")), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(status_code=504, detail="CGI subprocess timeout")

    if proc.returncode != 0:
        logging.error("CGI stderr: %s", stderr.decode("utf-8", errors="ignore"))
        raise HTTPException(status_code=500, detail="CGI subprocess returned error")

    raw_output = stdout.decode("utf-8")
    # Strip CGI headers (Content-Type, etc.) before returning JSON body
    return strip_cgi_headers(raw_output)


@app.get("/")
async def index():
    if STATIC_DIR is not None:
        index_file = STATIC_DIR / "index.html"
        if index_file.exists():
            return FileResponse(index_file, media_type="text/html")

    frontend_url = os.environ.get("FRONTEND_URL")
    if frontend_url:
        return RedirectResponse(frontend_url)

    return {"service": "ncplot7py-adapter", "status": "ok", "note": "No frontend build found"}




# --- Existing CGI Route ---


@app.get("/api/machines")
async def get_machines():
    """Return available machines with their configurations including file extension info."""
    config_path = resolve_machines_config_path()
    machines = []

    try:
        if config_path is not None and config_path.exists():
            with open(config_path, "r") as f:
                machines_data = json.load(f)

            # First pass: collect base machine configs
            base_configs: dict = {}
            for key, config in machines_data.items():
                if isinstance(config, dict):
                    base_configs[key] = config
                    machines.append({
                        "machineName": key,
                        "controlType": config.get("control_type", "FANUC"),
                        "channels": config.get("channels", 1),
                        "machineType": config.get("machine_type", "MILL"),
                        "fileExtensions": config.get("file_extensions", {}),
                    })

            # Second pass: resolve aliases
            for key, config in machines_data.items():
                if isinstance(config, str) and config in base_configs:
                    base_cfg = base_configs[config]
                    machines.append({
                        "machineName": key,
                        "controlType": base_cfg.get("control_type", "FANUC"),
                        "channels": base_cfg.get("channels", 1),
                        "machineType": base_cfg.get("machine_type", "MILL"),
                        "fileExtensions": base_cfg.get("file_extensions", {}),
                    })
    except Exception as e:
        logging.error("Failed to read machines.json for /api/machines: %s", e)

    if not machines:
        machines = [
            {
                "machineName": "FANUC_MILL",
                "controlType": "FANUC",
                "channels": 1,
                "machineType": "MILL",
                "fileExtensions": {
                    "multifile": True,
                    "main": [".PA", ".txt"],
                    "subprogram": [],
                    "channels": {"1": [".PA", ""], "2": [".p-2"], "3": [".p-3"]},
                },
            },
        ]

    return {"machines": machines, "success": True}


@app.post("/cgiserver")
async def cgiserver(request: Request):
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON request body")

    raw = json.dumps(data)

    output = await run_cgi(raw)

    try:
        return json.loads(output)
    except Exception:
        # If CGI returned non-JSON, pass raw output as error message
        logging.error("Invalid JSON from CGI: %s", output)
        raise HTTPException(status_code=502, detail="Invalid JSON from CGI subprocess")


# Serve favicon files directly so browsers requesting /favicon.svg or /favicon.ico
# don't get a 404 when the FastAPI backend is the same origin as the frontend.
@app.get("/favicon.svg")
async def favicon_svg():
    return RedirectResponse(url="/favicon/favicon.svg", status_code=307)


@app.get("/favicon.ico")
async def favicon_ico():
    return RedirectResponse(url="/favicon/favicon.svg", status_code=307)
