from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel
from pathlib import Path
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import importlib.util
import asyncio
import json
import os
import logging
from focas_service import get_focas_client, get_demo_focas_client, is_demo_ip, FocasClientBase, FocasError

app = FastAPI(title="ncplot7py-adapter")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CGI_PATH = os.environ.get("CGI_PATH", "/app/ncplot7py/scripts/cgiserver.cgi")
CGI_TIMEOUT = int(os.environ.get("CGI_TIMEOUT", "30"))
ENABLE_FOCAS = os.environ.get("ENABLE_FOCAS", "True").lower() in ("true", "1", "t", "yes")

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

@app.get("/api/features")
async def get_features():
    """Endpoint for frontend to query which backend modules are available."""
    return {
        "focas_enabled": ENABLE_FOCAS,
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


# --- FOCAS API Routes ---

class FocasConnection(BaseModel):
    ip_address: str
    port: int = 8193
    timeout: int = 10

class FocasDownloadData(BaseModel):
    program_text: str

@app.get("/api/focas/ping")
async def focas_ping(ip_address: str):
    if is_demo_ip(ip_address):
        return {"status": "success", "available": True}

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
    elif not ENABLE_FOCAS:
        raise HTTPException(status_code=501, detail="FOCAS support is disabled.")
        
    try:
        success = client.connect(conn.ip_address, conn.port, conn.timeout)
        if not success:
            raise HTTPException(status_code=500, detail="Failed to connect to CNC")
        
        # Optionally, could query some basic CNC machine info here via client to verify
        client.disconnect()
        return {"status": "success", "message": f"Connected to {conn.ip_address}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/focas/programs/{path_no}")
async def focas_list_programs(path_no: int, ip_address: str, port: int = 8193, client: FocasClientBase = Depends(get_focas_client)):
    if is_demo_ip(ip_address):
        client = get_demo_focas_client()
    elif not ENABLE_FOCAS:
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
    elif not ENABLE_FOCAS:
        raise HTTPException(status_code=501, detail="FOCAS support is disabled.")
        
    try:
        # FOCAS requires connecting, doing the operation, and disconnecting
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
    elif not ENABLE_FOCAS:
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

# --- Existing CGI Route ---


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
