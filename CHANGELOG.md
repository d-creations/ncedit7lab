# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Line-by-Line Stock Replay**: Optional Start, Previous/Next, Play/Pause and execution-timeline controls with opt-in cursor/occurrence following. Keep a worker alive, apply cutting prefixes incrementally, transfer dirty surface chunks and restore bounded hybrid-stock checkpoints for backward/forward jumps without backend reexecution.
- **Executed Command History**: Publish validated authoritative command occurrences, including non-motion commands, separately from plotted motions. Preserve repeated source lines and explicitly label older backend histories as motion-only.

### Changed
- **Smooth GPU Stock Shading**: Reconstruct display normals from bilinearly interpolated matching dexel intervals instead of finite differences across discontinuous columns. Reject interval-topology changes and disjoint walls, preserve stock subtraction and hit traversal, and shade the occupied side of a traced boundary. Add analytical cylinder-lighting regression thresholds for accuracy and striping.
- **Portable WebGPU Shaders**: Remove storage-buffer pointer function parameters from cutter, dexel-compute and stock-display WGSL. Register named global Three.js storage bindings instead, preserving the existing cutter mathematics and supporting shader validators without unrestricted storage-pointer parameters.
- **GPU Failure Handling**: Bound dexel compute submissions to 16,384 rays with queue completion and cancellation between batches. Preserve shader validation errors over missing-buffer readback failures and report WGSL compiler source locations where available. Reuse display interval bindings across stock states and disable GPU selection after device loss. Add Vite proxies for the Docker backend's current API routes.
- **Progressive GPU Stock**: Add an experimental WebGPU tri-dexel path with tiled cutter indexing, continuous supported milling/turning sweeps, GPU-resident interval subtraction and direct Three.js stock rendering. Show a 0.1 mm coarse result first and recalculate the selected executed prefix at the configured fine pitch (default 0.02 mm) after idle. Coalesce navigation, retain bounded visited GPU states and reject obsolete refinement. Report unsupported geometry, interval/work overflow and memory limits explicitly; preserve the CPU replay fallback and never label sampling pitch as a certified machining tolerance. Upgrade Three.js and typings for WebGPU.
- **Compact Plot Simulation Controls**: Replace stock-binding and playback setup panels with bottom resolution/replay controls, default resolution to 0.05 mm and always follow the editor cursor once replay is prepared. Resolution changes preserve backend bindings and recalculate the captured stock without backend reexecution. Remove the timeline slider/follow checkbox and avoid redundant cached-surface transfers on unchanged non-cutting steps.
- **Stock Defaults Across Simulation Profiles**: Extend explicit zero-transform stock bindings to STAR SV-20R/SG-42 and FANUC/Siemens milling profiles, preserving existing demo/configured fidelity, machine kinematics and program overrides. Profiles without simulation kinematics remain unchanged.
- **Backend Stock Defaults**: Read explicit machine-profile stock bindings from backend definitions, automatically bind a single matching executed workpiece frame, and prefill removal setup while preserving per-program overrides and configured spindle directions. Add validated zero-transform main/sub-spindle defaults to the installed STAR SR-20R IV Type B backend definition; unmatched/multiple frames retain explicit manual setup.
- **Default Stock Detail**: Default the material-removal boundary spacing to 0.05 mm instead of 0.5 mm; explicitly chosen resolutions remain supported.
- **Cold Replay Extraction**: Reuse bounded packed seam topology between discovery and breakpoint collection instead of repeating analytical sampling. Preserve exact coordinates, spans, edge masks, fine Hermite data and seam ordering; memory pressure explicitly falls back to the full streamed pass without lowering quality. Release optional topology on actual budget pressure rather than preflighting every breakpoint. A two-order live STAR cold-build comparison reduced turning/mixed meshing by approximately 21%/27% with bit-identical positions/normals; cold jumps still exceed the 1–2-second target. Add topology-reuse diagnostics and controlled STAR turning/mixed-prefix comparisons.
- **Replay Mesh Diagnostics**: Show extraction/triangulation/adaptation timings and rebuilt-chunk/triangle counts, distinguish first-visit and released/non-retained surface-cache misses, and report capacity, retained states, evictions and clears. Cached/unchanged frames no longer risk showing previous reconstruction timings.
- **Versioned Replay Surfaces**: Retain bounded visited-prefix surface manifests sharing exact immutable chunk versions, including normals and seam-dependent geometry. Warm jumps reinstall retained surfaces rather than remeshing; byte-identical versions are deduplicated and LRU eviction stays inside the existing memory budget.
- **Batched Replay Restoration**: Resolve and fetch stock-history records in bounded batches with up to four concurrent gzip decoders, preserving profile-first installation and reserving complete batch workspace before payload reads.
- **Partial Stock Replay History**: Adapt the Blasquez/Poiraudeau partial-history approach to spatial 3D stock regions. Record lossless changed-region and turning-profile versions during the first final calculation, gzip larger records into a bounded 256 MiB local IndexedDB cache, and selectively restore recorded jumps without repeating cutter subtraction or retaining a full mesh per line. Keep RAM/workspace within the unchanged limit and show explicit checkpoint/recompute fallback on cache failure.
- **Prepared Replay and Cursor Navigation**: Reuse the prepared worker for Start Replay and Final Stock, preserve operation diagnostics across recorded occurrences, remesh only changed regions on historical jumps, debounce editor-cursor following, and delete the worker-owned cache during normal cancellation/shutdown.
- **Replay Memory and Lifecycle**: Limit checkpoint history to four states / 64 MiB inside the unchanged 256 MiB estimated stock/workspace budget. Evict optional history under pressure, preserve fine cutting detail, copy transferred mesh buffers, coalesce pending seeks safely and cancel replay on obsolete runs. Final stock remains the default; playback is stock-update-paced, not NC-time-accurate.
- **Hybrid Turning Stock**: Keep proven coaxial cylindrical turning in a 2D radial/axial base profile with coarse stock regions; refine only local 3D milling detail and preserve earlier pockets/holes when turning resumes. Reuse certified cylindrical and planar machined panels, exact supporting-plane pruning and topology-only seam discovery without reducing boundary spacing.
- **Operation Profiling**: Report contiguous turning/milling operation subtraction work, execution provenance, node/refinement/memory deltas and actual fast paths. Report final-only extraction, triangulation and adaptation diagnostics rather than inventing per-operation meshing times; reserve diagnostic history against memory limits.
- **Hybrid STAR Benchmark**: The supplied mixed program at 0.05 mm preserves all 162 motions and 15,891,836 removed samples. One ordered same-process comparison reduces runtime from 87.4 s to 29.5 s, fine cells from 400,339 to 62,026 and estimated peak memory from 251.2 to 73.7 MiB; timings remain hardware/load-dependent.
- **Spatial Ball-Sweep Batches**: Group up to 128 compatible fixed-orientation ball sweeps into a continuous union indexed by a cutter-frame BVH. Conservatively prune fields and update affected stock once per batch; preserve non-collinear paths, reversals, tool/frame changes, rotary fallback and original progress/stop metadata. Report subtraction/meshing times and separate primitive/traversal work.
- **Bounded Fine-Stock Storage**: Limit shared corner caching to 16,384 entries; compact uncrossed cells without discarding their fields; share bit-identical boundary fields with copy-on-write and bounded candidate metadata. Release cells already empty in the stored representation instead of retaining unused boundary buffers. Memory errors now report retained/workspace estimates and node/cell counts.
- **Streamed Boundary Meshing**: Extract one chunk at a time, preserve coarse/fine seam breakpoints, and charge retained surfaces during extraction. Complete the stock/mesher iterator integration. The supplied STAR mixed program completes at 0.05 mm within the unchanged 256 MiB estimated budget, with the reference removed-sample count; finite roots and crossed-edge normals are packed losslessly.
- **Error-Controlled Surface Adaptation**: Reduce eligible smooth interior mesh patches with a conservative deviation limit of 10% of boundary spacing (0.005 mm at 0.05 mm spacing) relative to the fine reconstructed mesh. Preserve seams and creases, retain unproven patches at fine detail, and do not claim this bound as cutter or physical machining accuracy.
- **Larger Removal Budgets**: Allow 16 million adaptive nodes, 256 MiB estimated stock/workspace memory, 1.2 million surface triangles, 400,000 sampled/swept volumes and 500 million evaluations. Keep chunk size, boundary spacing, cancellation and explicit resource errors unchanged; larger budgets allow longer jobs, not faster calculation.
- **Adaptive Material Removal**: Replaced uniform occupied voxel storage with an octree that batches solid/empty region updates and refines affected boundaries, while retaining untouched stock surfaces analytically.
- **Hermite Stock Surfaces**: Replaced cube/tetrahedral surfaces with shared-face contours using edge intersections and outward normals, bounded QEF feature vertices, and crease-aware shading. Preserve sharp stock and cut corners; validate exact Float32 closed surfaces across chunk seams and mixed turning/milling cuts.
- **Faster Stock Subtraction**: Precompute convex turning-envelope supporting planes, cache shared corner evaluations per sweep, use tolerance-bounded interpolated intersection searches, and batch only compatible contiguous straight analytical sweeps. Execution/progress counts, stopped prefixes and backend machining-mode rules are preserved.
- **Analytical Pristine Panels**: Reconstruct untouched box faces and cylindrical stock as stitched extrusion panels instead of finely meshing their full lengths. Keep the original fine cylinder cross section (zero additional axial sagitta error), fine rims/features and detailed cut boundaries, with exact Float32 seam regressions.
- **Certified Incremental Sweeps**: Bound completed axial flat-mill sweep history and skip only regions with proven signed-field dominance, including the covered portion of overlapping travel. Bounded exact-field keys also avoid identical milling/turning updates. Newly exposed ends and uncertified cutters still receive the ordinary update; AABB overlap alone never skips a cut.
- **Continuous Ball-Mill Sweeps**: Replace fixed-orientation lateral/diagonal ball-mill pose sampling with continuous finite-length sweeps of the rounded tip and cylindrical cutting body. Use analytical normals, batch compatible collinear travel, and certify lateral overlap or contained collinear return sweeps without skipping new cuts or rotary motion.
- **Bounded Mesher Workspace**: Avoid contour allocation in the capacity pass, reuse triangle scratch, construct seam maps only where coarse panels need them, account staging/cached surface buffers, and enforce the triangle cap on actual output. The bounded local .05 mm regression reduces surface buffers from 8,155,296 to 2,426,400 bytes without changing removed samples; timing is runtime-dependent.
- **Removal Detail and Diagnostics**: Renamed voxel size to boundary spacing and report refined cells, peak estimated stock memory and surface-buffer usage. Added dimensional, closed-surface, repeat-cut and 0.05 mm resource regression tests; final stock remains the default unless optional replay is started.

### Fixed
- **STAR Turning Removal Startup**: Verified singleton tool-selection, standard spindle and coolant state records no longer stop removal before the first feed. Unknown records and incomplete cutting motions remain explicit blockers; backend tool/offset and machining-mode rules are unchanged.
- **Ball-Mill Fields and Pose Identity**: Remove the artificial internal zero-field plane at the ball/cylinder equator. Normalize validated near-unit pose quaternions and use a stable relative angle so identical rounded orientations remain analytical; invalidate cached cutter geometry when a definition changes under the same tool number.

## [1.2.1] - 2026-10-05

### Added
- **Geometric Material Removal Preview**: Added bounded, chunked 3D voxel stock removal for a single-channel Simulation plot, including box/cylinder stock, swept flat/ball/corner-radius end mills and drills, and supported conventional turning inserts. Turning and milling subtract from the same stock so earlier pockets and holes remain removed.
- **Removal Setup**: Added explicit program-to-workpiece translation/rotation, workpiece-frame selection, turning spindle origin/axis, and configurable voxel size from 0.05 to 5 mm with a 0.5 mm default.
- **Background Computation**: Added a run-owned Web Worker with progress, cancellation, memory/work limits, and exposed stock-surface generation. Obsolete runs are cancelled without tying computation to editor cursor movement.
- **Removal Capability Diagnostics**: Unsupported operations, unknown feed modes, missing cutter geometry/poses, and frame changes stop removal at the affected execution step and source line. Rapids never remove stock; supported feeds are assumed cutting with a visible spindle-verification warning.

### Changed
- **Default Stock Frame Selection**: Removal setup preselects `workpiece:tableBC` when available, preserving an existing confirmed binding and still requiring explicit bind-and-run confirmation.
- **Removal Display Scope**: The preview displays final stock, or the valid stock prefix before an unsupported motion. Cursor-dependent stock history and timed playback are not included.
- **Cutter Geometry Consistency**: Milling previews share computational cutter profiles, and turning uses executed Q/reference data when available.

### Fixed
- **Backend Machining Mode Transport**: Preserve per-motion turning/milling mode through the API adapter instead of dropping it and leaving frontend motions unknown.
- **Non-Cutting Removal Stops**: Ordinary incomplete linear rapid records and verified FANUC mill singleton tool-selection markers no longer incorrectly stop removal. Incomplete cutting motions and unverified records remain explicit blockers.
- **Stock Placement and Resources**: Share initial stock placement/zero-reference transforms between rendering and computation, and dispose replaced stock meshes and shared rendering resources.

## [1.2.0] - 2026-10-05

### Added
- **Cutting Edge Q Orientation (0–9)**: Added theoretical tool-tip alignment for turning inserts based on controller cutting edge direction $Q$ (1–9, 0) and nose radius $R$. The tool assembly shifts automatically so the tangential touch-off point (virtual tip) aligns with $(0, 0, 0)$.
- **Reset Defaults in Tool Library**: Added a `Reset Defaults` button in the Tool Manager Library tab to reset standard default tools to factory presets while preserving custom user tools.

### Changed
- **Default Turning Insert Size**: Scaled standard turning insert presets from IC $9.525\,\text{mm}$ ($3/8^{\prime\prime}$) down to IC $4.7625\,\text{mm}$ ($\approx 4.8\,\text{mm}$ / $3/16^{\prime\prime}$), thickness to $1.59\,\text{mm}$, and nose radius to $0.2\,\text{mm}$ to match typical Swiss-lathe tooling.
- **Default Tool Mounting Orientations**: Standardized turning inserts to `[0, 90, 0]`, front/radial milling tools to `[0, 90, 0]`, and counter-face tools to `[270, 0, 0]`.
- **Automatic Library Migration**: Extended default-tool detection to automatically upgrade older stored standard library tools (including $12\,\text{mm}$ and $9.5\,\text{mm}$ inserts) to the new geometry, orientation, and $Q/R$ defaults upon loading.

### Fixed
- **Plot Tool Simulation Orientation**: Fixed double-application of tool mounting orientation in `NCToolpathPlot` where `pose.orientation` was premultiplied onto an already-oriented tool mesh, ensuring 3D plot orientation matches the preview 1:1.
- **Effective Toolpath Selection**: Restored `Effective path` as a selectable and persisted plot mode instead of silently normalizing it to `Tool-center path`.

## [1.1.0] - 2026-09-21

### Added
- **Toolpath Mode Selection**: Added selectable `Effective path` and `Tool-center path` plotting modes. Effective mode returns the programmed contour; center mode returns the backend-compensated tool-center path.
- **Tool Simulation**: Added an optional plot simulation toggle that displays the selected tool at its emitted backend pose alongside the plotted path.
- **Path Mode Persistence**: The selected toolpath mode is preserved in application state and captured in immutable plot runs.

## [1.0.7] - 2026-08-13

### Added
- **Channel Spacing Controls**: Added `||` and `| |` header actions to add or remove one leading two-space prefix on every line of the clicked channel only.
- **Machine Selector Filters**: Added `All`, `Mill`, and `Turn` filters (with turn-mill profiles included) plus `All`, `Fanuc`, and `Siemens` control-family filters. Filtering automatically selects an available configured machine and resolves incompatible filter combinations without leaving the selector empty.

## [1.0.6] - 2026-08-12

### Added
- **Multichannel Alignment Controls**: Added symbol-only `=` and `/=` actions to each channel header for explicitly applying or removing visual alignment across two or three active channels.
- **Aligned Channel Scrolling**: Applying alignment synchronizes vertical scrolling across channel editors; removing alignment disables synchronized scrolling.

### Changed
- **Server-Defined Alignment Syntax**: Synchronization markers are always detected using the CGI `get_line_alignment_syntax` response, with no hardcoded control syntax or fallback matching in the client.
- **Reversible Alignment Lines**: Visual alignment uses separate two-space padding lines, and removal is limited to padding adjacent to shared markers matching the server-provided syntax.
- **Machine Control Families**: The backend machine list now returns canonical configured control families, allowing machine profiles such as `FANUC_MILL` to resolve the shared `FANUC` alignment syntax.
- **Plot Interface and Execution**: Alignment controls are no longer shown in the plot area, and plotting does not add, remove, or recalculate channel alignment; it executes the current editor content unchanged.
- **Channel Plot Requests**: The Plot button in a channel header now sends only that channel to the backend instead of using a multichannel request.
- **Alignment Matching**: Two-space padding lines are added only around unique synchronization markers matched from the server-provided syntax and shared in the same order by every active channel; no fallback matching is used.

## [1.0.5] - 2026-08-02

### Changed
- **USB Transfer — Source Extensions**: Pulled programs now retain their original USB file extension instead of always using the configured channel default.
- **USB Transfer — Multichannel Pulls**: Combined pulls now support programs found across any configured channel combination, including P3.
- **Transfer Panel — Simplified Actions**: Program rows now provide one Pull action with channel-specific Compare actions, and pushing is limited to the currently open file.

## [1.0.4] - 2026-07-30

### Changed
- **USB Transfer — Main and Subprogram Extensions**: Added machine-configured `.M` support for P1/main programs and `.S` support for P2/subprograms when listing, pulling, comparing, and pushing programs.
- **Transfer Panel — Channel Labels**: Transfer actions now show the CNC channel before its configured file convention, such as `P1 Main (.M)`, `P2 Sub (.S)`, and `P2 (.p-2)`.
- **USB Transfer — Channel Filtering**: Programs with the same O-number but different channel extensions are now kept separate and pulled from the selected channel.

## [1.0.3] - 2026-07-28

### Changed
- **NC Code Editor — Comment Colours (Light Theme)**: Parenthesis comments `(...)` in the GitHub light theme are now rendered in `#6a737d` instead of the near-invisible `#998` default.
- **NC Code Editor — Block-Skip Lines (Light Theme)**: Lines starting with `/` (block-skip modifier) are now highlighted in blue (`#0550ae`) to distinguish them from regular comments.
- **NC Code Editor — Comment Colours (Dark Theme)**: Comments in the One Dark theme are now brighter (`#848da0` vs. default `#5c6370`) for better readability, with block-skip lines shown in `#61afef`.

## [1.0.2] - 2026-07-28

### Changed
- **3D Toolpath Plot — Zoom to Fit on Plot**: Camera now automatically fits to the toolpath bounding box whenever a new plot is rendered.
- **3D Toolpath Plot — Reset View**: "Reset View" button now calls Zoom to Fit instead of a hardcoded camera position, falling back to the default position only when the scene is empty.
- **3D Toolpath Plot — Axis-Align Views (X-Y, X-Z, Y-Z)**: All axis-align view buttons now re-center the orbit target on the actual geometry before repositioning the camera, enabling consistent deep zoom after view alignment.

## [1.0.1] - 2026-06-24

### Added
- **Template Manager**: Introduced a new template manager to handle code snippets and blocks.
- **USB Transfer Protocol**: Added support for direct file and program transfer via USB connectivity.

### Changed
- **Siemens 840Di**: Updated and improved support for the Siemens 840Di control:
  - Fixed an issue where variables starting with axis letters (like `Z_POS`) would lose their assignments during sanitization.
  - Parameter parentheses `( )` such as those used in `CYCLE800` are now safely preserved instead of being stripped out as comments.
