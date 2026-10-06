# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- **Adaptive Material Removal**: Replaced uniform occupied voxel storage with an octree that batches solid/empty region updates and refines affected boundaries, while retaining untouched stock surfaces analytically.
- **Hermite Stock Surfaces**: Replaced cube/tetrahedral surfaces with shared-face contours using edge intersections and outward normals, bounded QEF feature vertices, and crease-aware shading. Preserve sharp stock and cut corners; validate exact Float32 closed surfaces across chunk seams and mixed turning/milling cuts.
- **Faster Stock Subtraction**: Precompute convex turning-envelope supporting planes, cache shared corner evaluations per sweep, use tolerance-bounded interpolated intersection searches, and batch only compatible contiguous straight analytical sweeps. Execution/progress counts, stopped prefixes and backend machining-mode rules are preserved.
- **Analytical Pristine Panels**: Reconstruct untouched box faces and cylindrical stock as stitched extrusion panels instead of finely meshing their full lengths. Keep the original fine cylinder cross section (zero additional axial sagitta error), fine rims/features and detailed cut boundaries, with exact Float32 seam regressions.
- **Certified Incremental Sweeps**: Bound completed axial flat-mill sweep history and skip only regions with proven signed-field dominance, including the covered portion of overlapping travel. Bounded exact-field keys also avoid identical milling/turning updates. Newly exposed ends and uncertified cutters still receive the ordinary update; AABB overlap alone never skips a cut.
- **Continuous Ball-Mill Sweeps**: Replace fixed-orientation lateral/diagonal ball-mill pose sampling with continuous finite-length sweeps of the rounded tip and cylindrical cutting body. Use analytical normals, batch compatible collinear travel, and certify lateral overlap or contained collinear return sweeps without skipping new cuts or rotary motion.
- **Bounded Mesher Workspace**: Avoid contour allocation in the capacity pass, reuse triangle scratch, construct seam maps only where coarse panels need them, account staging/cached surface buffers, and enforce the triangle cap on actual output. The bounded local .05 mm regression reduces surface buffers from 8,155,296 to 2,426,400 bytes without changing removed samples; timing is runtime-dependent.
- **Removal Detail and Diagnostics**: Renamed voxel size to boundary spacing and report refined cells, peak estimated stock memory and surface-buffer usage. Added dimensional, closed-surface, repeat-cut and 0.05 mm resource regression tests; final-stock-only behavior remains unchanged.

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
