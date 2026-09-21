# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
