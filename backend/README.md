# Backend Service

This folder contains the FastAPI backend used by NC-Edit7. It serves the built frontend when available, exposes the backend API used by the editor, and bridges to the `ncplot7py` CGI and Transfer helpers.

## What it serves

- `GET /` serves `dist/index.html` when the frontend has been built, or falls back to `public/index.html` during development.
- `GET /config.json` serves the runtime configuration file.
- `GET /api/features` reports which backend features are enabled.
- `GET /api/machines` returns the machine list used by the frontend machine selector.
- `GET /api/syntax/{control_type}` returns ACE syntax rules for the requested control type.
- `GET /api/transfer/ping`, `POST /api/transfer/connect`, `GET /api/transfer/programs/{path_no}`, `GET /api/transfer/upload/{path_no}/{prog_num}`, and `POST /api/transfer/download/{path_no}` expose the Transfer integration.

The transfer backend supports both `focas` and `usb` protocols. In `usb` mode, the `ip_address` field is treated as a filesystem path that the backend can access locally.

## Run locally

The updated adapter requires the matching ncplot7py package containing
`domain.simulation_contract`. Rebuild/redeploy the package and adapter together;
changes to a sibling checkout do not update an already running container.

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
- `ENABLE_Transfer` enables or disables Transfer routes. The default is `True`.

## Notes

### Plot API update (2026-09-14)

- CGI and FastAPI execute all selected channels in one engine call and report `executionOrigin: "engine"`. Failed/unavailable execution or recorded NC errors return `success: false`; no automatic mock replacement. Legitimate empty output remains successful.
- FastAPI now passes `toolPathMode` into each channel state, so `center` reaches the actual projector.
- Explicit `rValue: 0` is valid in `toolValues` and selected positive-numbered `toolOffsets` records. It means zero radius displacement, not missing data, G41/G42 cancellation, or a fallback to another radius. Negative/missing radius still fails compensation activation. Register zero is a cancellation selector, not a stored register.
- Discovery exposes `axes`, `availableChannels`, `profileRevision`, `supportedPoseContracts` and validated `simulation` when configured. Undeclared axes are returned as an empty array, not guessed XYZ.
- Simulation configuration validation and pose-request negotiation are implemented. No verified pose producer is installed: `supportedPoseContracts` remains empty and pose requests are rejected before execution, never silently downgraded. Moving-tool poses, demo profile activation and frontend transport remain pending.

See the [contract](../docs/tool-management-plan.md#116-the-render-contract-resolved-poses-not-raw-abc)
and [backend calculation specification](../docs/backend-tool-pose-calculations.md).

- The backend reads `ncplot7py/config/machines.json` when it is available to provide the machine list and control-specific syntax rules.
- Static assets are served from the built frontend output first, with `public/` as a fallback for local development.