# Backend Service

This folder contains the FastAPI backend used by NC-Edit7. It serves the built frontend when available, exposes the backend API used by the editor, and bridges to the `ncplot7py` CGI and FOCAS helpers.

## What it serves

- `GET /` serves `dist/index.html` when the frontend has been built, or falls back to `public/index.html` during development.
- `GET /config.json` serves the runtime configuration file.
- `GET /api/features` reports which backend features are enabled.
- `GET /api/machines` returns the machine list used by the frontend machine selector.
- `GET /api/syntax/{control_type}` returns ACE syntax rules for the requested control type.
- `GET /api/focas/ping`, `POST /api/focas/connect`, and `GET /api/focas/programs/{path_no}` expose the FOCAS integration.

## Run locally

The backend app entrypoint is `backend.main_import:app`.

With Docker Compose:

```bash
docker-compose build backend
docker-compose up backend
```

Without Docker:

```bash
pip install -r requirements.txt
uvicorn backend.main_import:app --host 0.0.0.0 --port 8000 --reload
```

## Environment variables

- `CGI_PATH` sets the path to the CGI script used by the subprocess bridge. The default is `/app/ncplot7py/scripts/cgiserver.cgi`.
- `CGI_TIMEOUT` sets the CGI subprocess timeout in seconds. The default is `30`.
- `ENABLE_FOCAS` enables or disables FOCAS routes. The default is `True`.

## Notes

- The backend reads `ncplot7py/config/machines.json` when it is available to provide the machine list and control-specific syntax rules.
- Static assets are served from the built frontend output first, with `public/` as a fallback for local development.