# NC-Edit7 Pro

CNC NC code editor view with plot interface.

The editor integrates the ACE text editor and enables the plotting of toolpaths with the three.js library.

In the browser, **New** creates a file with an independent blank program in each
of the three channel memories. Each program becomes active in its channel, so
code entered there is stored and available to **Plot**. Existing programs remain
available in **Loaded Programs**; creating or selecting a blank file does not
change which channels are visible.

**Plot** stores the selected machine in each non-empty plotted program's
`@NCE-SIM:1` setup comments, preserving existing material and tool definitions.
Save the edited program as usual to keep this information in the NC file.
Opening or selecting a program restores its saved machine after the backend
machine list has loaded. If that machine is unavailable, the first machine in
the list is selected and an error notification is emitted. Programs without
setup metadata keep the current selection. Writing setup comments requires the
selected machine to provide a supported simulation comment syntax.

Licensing note: NC-Edit7 source code is licensed under the MIT License. Some repository variants or releases may also include runtime files 
. Those  files are proprietary  software, redistributed under redistribution terms, and are not covered by the MIT License.

## Live Demo

You can find the new version of the editor here: https://ncedit7.azurewebsites.net/

![NC-Edit7 editor preview](https://raw.githubusercontent.com/d-creations/NC-Edit7/master/public/images/image.png)

Platform-ready logo assets are stored under `public/branding/`; screenshots remain under `public/images/`.



## Local Development

To run the project locally:

```bash
npm install
```

Start the Docker backend with `docker compose up --build`, then run `npm run dev`
for frontend development. Vite proxies `/api` and `/cgiserver_import` to the
Docker backend at `http://127.0.0.1:8000`. The built frontend is also available
directly at that backend URL after a production build.

To build for production:

```bash
npm run build
```

## Testing

Run unit tests with:

```bash
npm run test
```

## Hybrid turning preview

With experimental GPU stock enabled, cylindrical stock stays in a compact
radius–axial interval arrangement while its executed cutting prefix consists
only of validated conventional coaxial turning. This reuses the CPU strategy's
double-precision meridian math, including insert nose envelopes, shoulders,
facing, annular grooves, bores and cutoff gaps. Stock placement and the explicitly
bound spindle are checked in stock-local coordinates; tool numbers do not select
the machining mode.

These prefixes allocate **no tri-dexel rays**, including at 0.02 mm fine detail.
The display revolves the exact meridian bands; its circumferential chord sagitta
is at most half the selected coarse/fine pitch. That display approximation is
not a certified physical machining tolerance or a change to the removal math.

The first milling/drilling cut (including coaxial drilling), or non-coaxial
turning, switches that prefix to the existing 3D dexel path. A cold transition
replays **all preceding cuts at the selected dexel pitch**, not a coarse mesh or
an unmachined cylinder. Later turning subtracts from the same 3D material and
never re-revolves it. Earlier timeline prefixes can still display their own
rotational stock; forward navigation cannot resurrect later pockets or holes.
Immutable stock caches, GPU tile sharing/history and stopped-prefix handling
remain in effect.

**Limitations:** conversion to 3D can still be expensive: a diameter 20 × length
50 part at 0.02 mm may exceed the existing 256 MiB buffer budget once cuts affect
broad 3D regions. This implementation defers that allocation; it does not claim
compact-profile-seeded sparse 3D storage. Refinement failures retain the last
displayed stock and report an error. Requested pitch is never silently enlarged;
automatic CPU fallback is limited to known capability failures and only when
the configured CPU resolution preserves the requested detail. Explicitly
selecting CPU remains available. Feedback stays progress-only, with warning/error
icons and console details. CPU/reference tests validate geometry and lifecycle,
not WebGPU hardware execution or timings.

## Transfer Configuration

The transfer panel is configured at runtime through `public/config.json` or the VS Code host configuration.


For USB storage transfer:

```json
{
	"showTransferPanel": true,
	"transferProtocol": "usb",
	"transferDefaultIp": "E:/"
}
```

In USB mode, `transferDefaultIp` is interpreted as a filesystem path visible to the backend process. Path 1 uses the selected root folder directly. Optional `PATH2` and `PATH3` subfolders are used when present.
