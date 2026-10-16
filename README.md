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
turning, switches that prefix to the existing 3D dexel path. The exact preceding
meridian bands become an **immutable implicit base for that executed prefix**,
not a coarse mesh or an unmachined cylinder. Subsequent eligible coaxial turning
updates a new base version, including after milling. Only asymmetric cuts allocate
interval tiles; their bounds are conservatively clipped to remaining turned stock.
Analytical stock-local ray intersections support all three axes, bores, annuli,
cones and cutoff gaps; initialization, rendering, GPU copies and history restores
use the same base. Forward copies intersect existing milling-modified ray
intervals with the new base, using private tile slots and explicit overflow checks.
They never replace those intervals with a fresh revolved surface. Earlier timeline prefixes can still display their own
rotational stock; forward navigation cannot resurrect later pockets or holes.
Immutable stock caches, GPU tile sharing/history and stopped-prefix handling
remain in effect. History is used only with its matching implicit-base fingerprint;
checkpoints never restore a later turning base into an earlier prefix.

GPU replay reserves the smallest supported interval capacity that fits the
implicit base and any copied source, starting at four intervals per ray.
An explicit interval overflow retries at 8, 16, 32 and finally 64 intervals,
without changing the ray grid or pitch. This reduces unused tile storage in
simple turning/milling parts; complex cuts may still require larger capacities
and additional retry work. Failed attempts are disposed and displayed/source
stock remains immutable. Direct stock/reference helpers retain their existing
16-interval default; adaptive selection is owned by the replay session.

The 3D plot renders on demand, not continuously while editing. Camera controls
(including damping), plot/stock/tool/selection changes, theme changes and resizing
request coalesced frames. Hidden views/tabs defer rendering; GPU frames remain
limited to one in flight, with changes during that frame drawn after completion.
An unchanged view schedules no animation frames or repeated GPU renders. This
does not eliminate the cost of an individual render or background stock compute.
WebGPU camera controls use immediate motion without post-input damping so a
camera gesture does not start a tail of costly stock renders. WebGL keeps damping.
Unchanged background colors and repeated same-size resize notifications do not
invalidate the view.

Mixed-stock preparation builds the initial turning base in the cancellable replay
path, yielding to the browser every 16 timeline motions instead of first running a
synchronous turning prepass. Workspace checks use cached compiled-sweep and
profile-slab byte totals, refreshed when their contents change; they do not rescan
the entire program/profile for every inner profile reservation. These changes
preserve geometry, pitch and memory limits. Individual profile updates, GPU
submissions and stock renders can still be expensive; this is not a hardware
hang guarantee.

History staging is bounded **before each compute submission** by its ray count,
cutter count and four-event-per-cutter ceiling, then drained after queue completion.
The staging ceiling remains 1,048,576 events and the separate total retention
ceiling remains 4,194,304 events (usually lower under the shared memory budget).
Exhausted retention explicitly disables history, not completed material removal.

**Limitations:** subsequent broad changes can still be expensive: a diameter 20 × length
50 part at 0.02 mm may exceed the existing 256 MiB buffer budget once cuts affect
broad 3D regions. Compact-profile-seeded sparse storage removes the initial
whole-turning replay allocation, including later eligible turning; it does not
provide unlimited/out-of-core asymmetric removal. Non-coaxial turning still uses
3D tiles. The implicit base supports at most 64 disjoint intervals per ray;
excess complexity fails explicitly. Refinement failures retain the last
displayed stock and report an error. Requested pitch is never silently enlarged;
automatic CPU fallback is limited to known capability failures and only when
the configured CPU resolution preserves the requested detail. Explicitly
selecting CPU remains available. Feedback stays progress-only, with warning/error
icons and console details. CPU/reference tests validate geometry and lifecycle,
not WebGPU hardware execution or timings.

Nonbrowser allocation checks for Ø20 × 50 stock at 0.02 mm used 6,225,920
logical rays: a localized subsequent cut materialized 5 tiles / 5,120 rays,
with a 1,726,604-byte combined stock estimate. The unchanged saved full fixture's
first milling phase (its original 3 mm mill, not the latest 2 mm definition)
needed 290 tiles / 296,960 rays and a 78,597,256-byte dexel-layout estimate.
These are actual allocation/preflight measurements, not GPU timings or a
whole-program fine-resolution guarantee.

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
