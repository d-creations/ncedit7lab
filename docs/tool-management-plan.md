# Tool management and portable simulation metadata

### Current implementation status (2026-09-14)

The following status supersedes earlier dated milestone statements in this file.

- `FANUC_MILL_DEMO`, `SIEMENS_MILL_DEMO`, `FANUC_MILL` and `SIEMENS_840DI`
	provide the verified B/C `workpiece-tool-reference-v1` contract. One centre-mode Plot request submits
	profile revision plus `simulation.tools`; FastAPI and CGI return one aligned
	workpiece-frame position/quaternion pose per emitted point.
- The engine uses the tool's supplied mounting orientation together with the
	configured B/C table chain. Explicit B/C initial axes avoid implicit-zero
	assumptions, and pose quaternions keep their sign continuous across a primitive.
- `ExecutedProgramService` stores poses in the immutable plot run. Cursor
	occurrence selection resolves the run-owned tool definition, and
	`NCToolpathPlot` displays one selected milling mesh at the selected segment's
	endpoint pose. The mesh is removed and GPU resources are disposed on selection,
	run and component cleanup.
- The FANUC demo has been verified with real O-code containing `T2500`, `T2200`
	and `T2900`. Valid milling definitions are sent even when the same program
	also contains unsupported inserts or geometry-free tool records. To display a
	tool, select a plotted motion after the tool call; selecting the `T2500` line
	itself has no coordinates and therefore has no tool pose.
- `ToolGeometryFactory` renders validated `endMill`, `ballMill` and `drill`
	cutting geometry, box/cylinder/cone/profile holders, all currently supported
	insert outline codes (C/D/V/W/T/S/R and E/H/O/P/L/A/B/K), and box/cylinder
	material preview meshes. Insert/profile geometry is normalized to the local
	virtual-tip origin and covered by focused bounds/alignment tests. Shared mesh
	caching, custom geometry, plot-click selection and timed playback remain
	pending.
- The browser tool library now starts with editable seed definitions for the
	supported standard turning-insert outline codes plus drills and end mills from
	0.5 mm through 20 mm in 0.5 mm increments. Existing, malformed or newer stored
	libraries are preserved rather than overwritten by seed upgrades. Front mill
	and drill presets use assembly orientation [0, 270, 0], counter-face presets
	use [270, 0, 0], and primitive cutter geometry uses the tool front/tip as its
	local zero reference.
- SR20R, SV20R and SG42 expose configured STAR pose mappings. Their per-motion
	target context includes tool carrier, workpiece carrier and target axis;
	`M171` selects main spindle/C1 and `M172` selects subspindle/C2. Full machine
	calibration, transfer simulation, turning Q/nose semantics, length/TCP behavior
	and full-machine simulation remain outside the verified scope.
- On STAR, `M03` resets the active physical C axis to `0` before spindle motion:
	`C1` for the main spindle and `C2` for the subspindle. The reset is execution
	state and is retained in the following motion context; it is not derived from
	RPM or channel number.

Verification currently covers FastAPI/CGI pose parity, B/C mill profiles and
STAR target projection (44 backend regression tests), plot selection/tool
placement, execution transport (16 service tests), focused geometry generation
and local virtual-tip alignment (17 frontend tests), and a successful frontend
build. The backend compensation suite still contains five pre-existing
nonzero-radius entry/join failures.

### Selection update (2026-09-14)

The same-view cursor path now uses a per-run source/occurrence index. It selects
the last subsegment of the first matching executed occurrence; the pure resolver
also accepts a preferred execution step. The renderer draws the selected segment
directly, without searching a cloned segment list or falling back to line matching.
Missing execution steps disable selection for that location; missing channel IDs
are not treated as matching every channel. No move or invalid source context clears
the highlight. This supersedes the legacy selection fallback proposed below.
An occurrence chooser now selects explicit execution steps and preserves the choice
while the cursor stays on the same source line. Invalid explicit steps are rejected,
not replaced by the first occurrence. Selection notifications include run/source and
segment identity plus run-owned tool availability, without transporting geometry.
Stale/cleared runs disable the chooser. Plot-click and timed playback remain
pending. The selected cursor occurrence now drives the verified MILL_DEMO tool
pose preview; focused tests cover selection, channel isolation, occurrence
switching, highlight disposal and mesh placement.

Status (2026-09-14): metadata/codec, browser library, Program Tools/offset edits,
immutable editor Plot runs, same-view occurrence selection, B/C mill poses,
configured STAR target poses, selected milling-tool preview and standalone
turning/profile/material geometry preview are implemented. Setup/material UI,
turning execution poses, exact nose-centre/virtual-tip machine semantics,
playback, machine calibration and material removal remain pending.
Section 11 contains both implemented contract details and broader future work; the
current-status section above defines the active implementation boundary.

### Implementation progress — editor Plot actions

Backend tool/offset contract update (2026-09-11): machine `tool_selection` policy
now generates tool-detection metadata and drives existing execution-chain tool
handlers. Optional `machinedata[].toolOffsets` records separate compensation
registers from physical tool IDs; FANUC registers are global per channel,
Siemens records include the exact numeric/named tool ID. `ExecutionRequest` and
immutable `PlotRunInput` can carry these records. Managed `TOOL` comments
provide one Q/R default per physical tool, while a separate managed `OFFSETS`
block persists the program's controller offset table. Explicit offset tables do not merge with
or fall back to defaults when a selected record is missing. This is not a claim
of implemented turning nose, tool-length, M6 sequencing or TCP simulation.

- Channel-header and global Plot capture the exact pending ACE text, document/program/channel identity and editor-instance revision before execution. Editor revisions are local read tokens, not extension-host acknowledgment/edit contracts. Without an editor, the file-manager source is used and exact text is also checked for staleness; empty editor text never falls back to old state.
- Optional holder/cutting length and edge data are parsed from program comments only when Plot starts, and retained in the immutable run. No library or geometry network fetch occurs on editing/cursor movement. Missing geometry and Q/R-only tools remain valid; no meshes or accurate placement are claimed.
- Machine profiles carry optional explicit `simulationCommentSyntax` from `/api/machines`. Nothing is inferred from machine names or highlighting regexes. The deployed backend must advertise this capability to enable embedded metadata; its current local profile adapter does not manufacture it. Metadata with missing/invalid syntax or diagnostics blocks the request visibly. Header writing/conversion and automatic setup-machine restoration remain pending; a setup/selected-machine conflict is rejected.
- Q/R inputs live in program-scoped `ProgramToolService` state rather than a plot-time tool-list DOM query. Tool List exposes an explicit Apply action that writes a revision-checked managed `TOOL` block while preserving existing geometry. The Tool Manager Offsets tab similarly applies one managed `OFFSETS` block; Plot itself never writes comments or saves files.
- `ExecutedProgramService.executePlotRun()` owns a deeply frozen copy of the source snapshots, effective overrides, custom variables, machine profile and completed combined paths. `getPlotRun()` / `getRunTool()` preserve scoped exact identifiers, reject unavailable-tool lookup, and retain at most five runs. Recognized managed blocks are blanked only in the execution copy, preserving source line numbers. The backend still receives only existing centre-mode/Q/R/variable request fields.
- `PLOT_RUN_COMPLETED` is emitted once after storage, replacing the plot's per-channel and awaited duplicate render paths. Per-channel execution notifications remain for errors/variables, now correlated by run ID on this path. Superseded/cleared responses do not update either plot or editor execution consumers; failures retain the previous run. Changed source/profile/Q/R/custom-variable inputs mark old paths stale and disable editor-follow highlighting. The selection resolver, occurrence chooser and verified MILL_DEMO moving-tool pose are implemented; plot-click and timed playback remain future work.
- Event subscriptions and owned path/highlight resources are released on clear/replacement/disconnect. Host-separated views still need explicit run transport; these changes apply to one application instance only.
- Verification: 130 tests across 11 files, including real Plot event wiring in jsdom without WebGL. Interactive browser automation was skipped; deployed engine/tool-reference behavior remains unverified.

### Implementation progress — first frontend milestone

- Added shared raw response contracts and preserved exact numeric/named/zero/unknown/null/missing tool IDs and execution steps on every rendered subsegment. Original response ordinals and adjacent-point-pair indices remain channel-scoped, including after global plot concatenation; unsupported motion filtering is unchanged.
- Single- and multi-channel execution now use one request builder that always sends `toolPathMode: 'center'`. Legacy mode arguments remain accepted but cannot override this. The selector shows a fixed Center path indicator; persisted settings and undo/redo snapshots normalize to centre mode.
- Added regression tests for repeated coordinates/source lines, shared cycle steps, sampled arcs, independent runs/channels, exact supported request payloads and state restoration. Frontend build, full Vitest suite, changed-file ESLint and whitespace checks pass.
- Next milestone foundation is now delivered below. No tool-library persistence, moving meshes, run store or occurrence-selection UI is claimed by these increments. Deployed engine activation/compensation semantics still need end-to-end verification.

### Implementation progress — metadata/snapshot foundation

- [SimulationMetadata](../src/services/tools/SimulationMetadata.ts) defines and validates the fixed-mm schema: optional Q/R-only tools, holder box/cylinder/cone/axial profile (`points: [[z,radius], ...]`), drill/endMill/ballMill/insert cutters and box/cylinder material. Explicit transforms and first-holder-only stick-out are retained. C/D/V/W/T/S/R and extended E/H/O/P/L/A/B/K insert codes are distinct; L/A/B/K require dimensions. The frontend factory now generates preview outlines for every listed insert code and normalizes generated profile/insert geometry to a local z-origin; this remains parameter validation and preview geometry, not verified machine tip semantics.
- [SimulationCommentCodec](../src/services/tools/SimulationCommentCodec.ts) parses/encodes SETUP and TOOL blocks with explicit caller-supplied standalone `;`, `//` or `(...)` syntax. It does not infer capabilities from machine names/regexes, choose header insertion positions or edit programs. Unknown versions/types/fields, duplicates and malformed blocks retain original text/source spans and produce diagnostics. JSON is size/depth bounded; delimiter/Unicode escaping and numbered continuations are covered by tests.
- Continuation syntax is `key@1/N=<JSON fragment>` through `key@N/N=<JSON fragment>`, each independently commented. Records must be consecutive and ordered with a consistent total; reconstruct the JSON before parsing. The writer splits only between complete JSON escape tokens and obeys the supplied line limit. This remains an application proposal, not a released interchange standard.
- [ProgramToolService](../src/services/tools/ProgramToolService.ts) captures the exact supplied document/program/channel identity, revision and text; parses synchronously and freezes the detached result recursively. It has no library dependency or asynchronous parse cache. Invalid snapshots cannot project overrides; missing geometry and multiple cutters have explicit status. Metadata without supplied comment syntax is diagnosed rather than guessed. Metadata-free programs remain valid.
- [toToolValues](../src/services/tools/toToolValues.ts) preserves exact numeric/string identifiers and zero Q/R, omits absent overrides and rejects duplicate/unavailable IDs and nonfinite values. It does not derive compensation from geometry or impose unverified controller-specific Q/R ranges. Codec and snapshot services are centrally registered.
- Dedicated grooving/parting/threading/custom geometry and supplier-specific insert forms are not typed support yet: preserve their blocks verbatim and diagnose them, never substitute another cutter. No geometry-ready or machining-accuracy claim follows from a successful schema parse. Unit conversion/import UI, geometry bounds/rotation helpers and library storage are still pending.
- Verification: frontend build, 113 tests across 8 files, semantic ESLint and whitespace checks pass. Standard ESLint also exits successfully but reports formatting/CRLF warnings; no persistent lint configuration was relaxed.
- Subsequent editor Plot integration is described above. Safe header capabilities, host document edit contracts and metadata editing remain pending; the old temporary Q/R UI is preserved through shared program-scoped state.

### Machine visualization direction (2026-09-14)

Current implementation: a stationary workpiece-frame view displays the path and
one selected milling tool assembly for verified MILL_DEMO poses. Optional initial
material and a full machine digital twin remain future work. The implementation
reuses the run-owned tool ID, geometry snapshot and source/occurrence selection.

The execution boundary must supply a documented tool reference position and
orientation in the same workpiece frame as the displayed path. Resolve controller
units, compensation, table/head rotation and target spindle before publishing the
completed run, never during cursor movement. A/B/C are joint coordinates, not a
universal tool Euler rotation. Missing pose data leaves placement unavailable;
there is no guessed rotation, synthetic tool ID or replacement execution.

The [detailed plan in section 11](#11-minimal-machine-and-tool-visualization-plan)
distinguishes fixed-tool preview, rotary tool poses and full-machine simulation.

## 1. Main decision

Use two independent persistence layers:

1. **Local library:** reusable, editable tool definitions with stable IDs and revisions.
2. **NC program:** a complete snapshot of each selected tool, plus the selected machine name, encoded as machine-compatible comments.

The library is a source for selecting tools, not a dependency for reopening a program. Updating or deleting a library entry never silently changes an existing program. Program comments are the source of truth for that program's simulation setup; parsed application state is a derived cache.

## 2. Local storage

| Host | Recommended storage | Notes |
| --- | --- | --- |
| VS Code | Versioned JSON under `ExtensionContext.globalStorageUri`, through `workspace.fs` | Extension host owns persistence and broadcasts changes to webviews. Do not rely on webview localStorage. |
| Browser | JSON string in localStorage | Same versioned JSON format as VS Code/import-export; scoped to browser profile and site origin. |
| Both | JSON import/export | Explicit portable backup and migration between browser and VS Code. |

For desktop VS Code this is local disk storage; remote extension hosts may store it remotely. Neither host implies cloud sync. Browser data can be cleared, so provide an obvious Export Library action. An optional user-chosen shared library file can be added later, with conflict handling rather than last-writer-wins overwrites.

Use a versioned envelope containing `schemaVersion`, `libraryId`, `revision`, and `tools`. Each tool has its own stable UUID and revision. Tool numbers such as T1 are **program assignments**, not globally unique library IDs: the same drill can be T1 in one program and T12 in another.

Writes must validate first, use transactional storage where available, retain a last-known-good backup for files, and report failures without pretending a save succeeded. Serialize extension-host writes and reject stale revisions. For browser multi-tab edits, serialize read/check/write through the Web Locks API where available and notify other tabs through the storage event. A revision check alone is not atomic in localStorage; when locking is unavailable, restrict editing to one tab with an explicit warning rather than promising conflict-free concurrent editing. Unknown newer schema versions must not be overwritten.

### Application updates and persistent web storage

The editable library must not be stored inside bundled frontend assets: deployments replace those files. Bundled example tools are read-only seeds; seed upgrades must never overwrite user tools.

For web mode, use **JSON in localStorage on the user's computer**, as requested. Store the complete versioned library under a stable key such as `nc-edit7:tool-library`, using `JSON.stringify()` to save and validated `JSON.parse()` to load. This is browser-managed page storage, not a physical JSON file in the deployment and not sessionStorage (which is unsuitable for a reusable library).

It survives normal application deployments, reloads and browser restarts when the same browser profile and origin (scheme, hostname and port) are used. Keep the storage key stable across releases and migrate the schema without deleting/reseeding user tools. Preserve malformed or newer-version data instead of replacing it with defaults. Do not claim permanent retention: explicit site-data clearing, private-session cleanup, device failure or a changed domain can remove or make data unavailable.

This simple approach fits a modest library of descriptions and numeric/parametric geometry and follows the existing web template storage pattern. localStorage is synchronous and has a small browser-dependent quota (typically around 5 MiB for localStorage per origin, shared with other application data). Save on explicit Save/Apply, not every keystroke; handle blocked storage and quota errors visibly. JSON import/export remains essential for backups. Do not store base64 photos or large 3D meshes here; use generated previews initially and migrate behind the repository interface to IndexedDB if the library later needs large binary assets. Browser persistent-storage APIs are not a promise of permanent localStorage retention or extra localStorage capacity.

If "web machine storage" means **the hosting server**, that is a separate optional repository, not browser persistence:

- Add a backend tool-library API and store data outside the application image in a dedicated persistent volume or managed database. Container/image replacement must not replace the data; deleting a volume can still destroy it. The current compose setup binds the source checkout into the container and has no dedicated tool-library data volume.
- A single-user/self-hosted installation can use SQLite on a local persistent volume; JSON is possible with locking and safe replacement, but concurrent writes are harder. For multiple server instances, use a shared transactional database instead of independent container files.
- Public/multi-user hosting requires authentication, per-user or organization ownership, authorization on every library operation, revision-based conflict detection and backups. The current embedded API key/client ID is not user authentication and cannot isolate private libraries.
- Keep browser-local and server-backed modes explicit; do not silently upload local libraries or introduce implicit synchronization. Import/export remains available in both modes.

Selected initial approach: the same JSON schema in browser localStorage for web use and extension-owned files for VS Code, with JSON import/export between them. A server repository is optional only if cross-device/shared libraries are needed. Program-embedded tool snapshots stay unchanged under all storage choices.

## 3. Data model

### Compact definition — revised design

Keep the program fields to **toolNumber, description, Q, R, holder and cutting**, plus optional orientation when non-default. `holder` and `cutting` are arrays of typed geometry objects. Use named dimensions inside objects rather than positional number lists: `[20,20,100,55]` does not explain which number is stick-out and is hard to extend safely.

- No stored `channelId`: the containing program provides channel scope. Runtime services still scope by document/program so T1 in another program does not collide.
- No stored assignment ID in comments: derive identity from the containing program and exact tool identifier. Library IDs/revisions remain in the library; provenance in program comments is optional.
- One `description` rather than separate name and description fields in the compact program record.
- No top-level shank diameter, shank length, overall length or stick-out. Non-cutting dimensions belong to `holder` parts; cutting dimensions belong to `cutting` parts. Dimensions needed for geometry are relocated, not discarded.
- All stored distances/radii/diameters are **mm**, and all angles are **degrees**, fixed by schema version one. Do not serialize tool or machine `units` fields. Convert inch-based imports to mm. This does not change executable G20/G21 semantics: execution adapters must convert when supported or diagnose unsupported unit handling, never reinterpret inch NC motion as mm.
- No stored `frame`: coordinate conventions are defined once by the schema. Units and reference frames are distinct concepts, even though neither needs repetition in each record.

The library adds stable UUID/revision, optional tags/product designation and compatibility filters around the same geometry definition. Copy all effective geometry into program comments, not deltas against a library entry that might disappear. Omit only fields with immutable schema-defined defaults, such as zero position and identity orientation.

### Holder array — non-cutting assembly

Each element has a `type` and the dimensions relevant to it:

| Type | Geometry fields | Example use |
| --- | --- | --- |
| `box` | `width`, `height`, `length` | Rectangular/cuboid turning-tool holder or blade. |
| `cylinder` | `diameter`, `length` | Drill shank, boring bar, round adapter. |
| `cone` | `startDiameter`, `endDiameter`, `length` | Tapered adapter or transition. |
| `profile` | Ordered axial `[z,radius]` points | Custom rotational non-cutting body. |

All parts can carry `position:[x,y,z]` and `rotation:[rx,ry,rz]`; no hidden consecutive stacking assumption. Store assembly `stickOut` on the first holder element only; later elements must not redefine it. It is the distance from the active tool reference tip to the clamping plane along assembly +Z, not an extra translation to add to part positions. This also supports a box-shaped turning holder. A holder-less tool has no known clamping plane; do not invent stick-out.

### Cutting array — cutting geometry

- `drill`: `diameter`, `length`, `tipAngle` (included drill-point angle).
- `endMill`: `diameter`, `length`, `cornerRadius` where applicable.
- `ballMill`: `diameter`, `length` with hemispherical tip derived from diameter.
- `insert`: `shape`, `ic` (inscribed-circle diameter), `thickness`, `noseRadius`, `clearanceAngle`. Use explicit width/length/profile where IC and shape cannot fully determine the outline.
- `grooving` / `parting`: cutting width, cutting reach, thickness and corner radii; asymmetry/hand as needed.
- `threading`: profile family, included angle, pitch range or full-profile pitch, tip/root geometry and internal/external application. Do not approximate all threading tips as a V35 insert.
- `custom`: explicit validated outline/extrusion or supported revolved profile, not executable geometry code.

Every cutting element can carry its position and rotation relative to the assembly; this allows an insert offset from a rectangular holder. The initial UI should edit one active cutter plus multiple holder parts. Preserve but mark multi-cutter assemblies unsupported for execution until activation/compensation rules exist.

### Typical turning-insert shapes to support

Reviewed manufacturer guidance and a public insert-designation chart (see references). The common general-turning selector must include:

| Shape | Outline | Nominal included corner angle |
| --- | --- | --- |
| C | Rhombic/diamond | 80° |
| D | Rhombic/diamond | 55° |
| V | Rhombic/diamond | 35° |
| W | Trigon, not a plain equilateral triangle | 80° at working corners |
| T | Triangle | 60° |
| S | Square | 90° |
| R | Round | No single corner angle; circle defined by diameter |
| E | Rhombic/diamond | 75° |
| H | Hexagon | 120° |
| O | Octagon | 135° |
| P | Pentagon | 108° |
| L | Rectangle | 90°; needs width and length |
| A | Parallelogram | 85°; needs side dimensions |
| B | Parallelogram | 82°; needs side dimensions |
| K | Parallelogram | 55°; needs side dimensions |

Prioritize C/D/V/W/T/S/R for the first previews; include the extended shapes in the implementation/test scope rather than silently substituting another shape. The consulted chart also lists M (86° diamond), N (55° parallelogram) and X (special parallelogram). Treat these as extended catalog designations requiring supplier dimensions/explicit profiles, not as a claim of exhaustive ISO support. Do not confuse shape N with clearance N: letter position matters. Manufacturer-specific forms, grooving/parting, threading and wiper edges need dedicated/custom geometry beyond this shape list.

For standard shapes, derive the corner angle from the shape code instead of storing both (D always means 55°, V means 35°). Keep **clearance angle**, holder entering angle and mounting rotation distinct from that corner angle. Typical clearance codes: N=0°, A=3°, B=5°, C=7°, P=11°, D=15°, E=20°, F=25°, G=30°. Zero clearance is the negative-insert style; positive clearance does not itself specify rake angle or how the holder tilts the insert.

IC is not generally the outside diameter or cutting-edge length. Full designations such as CNMG/DCMT/VCGT may be retained as optional catalog text, but numeric size codes must not be assumed to be IC millimetres. Confirm dimensions from supplier data. Thickness and nose radius remain necessary for useful 3D geometry. Chipbreakers, screw holes and edge preparation may be omitted from a clearly labelled approximate preview; custom/wiper edge simulation needs its actual profile.

### Orientation and compensation

Q is controller/backend-specific compensation orientation, not a universal 3D rotation. Keep Q/R separate from physical geometry: R is the backend compensation radius, `noseRadius` describes an insert, and cutter radius is derived from cutting diameter. Confirm accepted Q/R semantics against ncplot7py before deriving defaults or enforcing ranges. Do not equate geometry length with an H/register length offset.

Schema convention: right-handed assembly coordinates, origin at the active tool reference tip, +Z from the tip toward the clamp. Primitive cylinders/cones extend from local z=0 to length; boxes are centered in local X/Y and extend from z=0 to length. Insert outlines lie in local XY, centered on their defined outline reference, and extrude along local +Z. For rounded tips, active reference-point selection must be defined and tested, not confused with the nose-radius centre. Explicit cutter transforms position that reference at the assembly origin.

Use degrees with fixed extrinsic X-then-Y-then-Z rotations (column-vector equivalent Rz·Ry·Rx), applied before translation. Optional top-level `orientation:[rx,ry,rz]` maps the whole assembly into the selected machine's canonical simulation coordinates; omit identity `[0,0,0]`. Tool-local insert rotations and top-level mounting orientation are separate. Provide tested machine-specific turning presets; Q must not silently rotate a second time. This fixed schema convention removes `frame` from comments without leaving geometry ambiguous.

## 4. Machine information in the program

Store the exact backend `machineName` and optional `material` in the setup block, not a display label, repeated units or control type. The surrounding metadata marker carries the schema version. Resolve control/comment capabilities through that machine profile; metadata geometry is always mm by schema convention.

On open:

1. Read recognized metadata comments without executing their contents.
2. Resolve the stored name through MachineService.
3. If supported and unambiguous, restore the selection and reparse using that profile.
4. If unknown, preserve the name and show a clear unresolved-machine state; do not silently run with a default machine.
5. If channels disagree, show a conflict because the current application uses a global machine selection. Do not let the last parsed channel win.

The machine name is enough to select an installed profile. It is **not** a complete machine model: exact future reproduction also needs profile/engine versions and, eventually, kinematics and setup data. A profile revision/hash can later detect drift without copying the whole machine configuration into every NC file.

Place the header near the top at a dialect-approved position, respecting mandatory `%`, program-number or Siemens file headers. Do not blindly prepend ahead of required syntax. For separate channel files, each must carry enough setup metadata to reopen independently. Verify multi-channel split/join round trips before choosing placement in combined containers.

### Material in the program header

Add one optional typed `material` object beside `machineName`. It is the **initial unmachined material**, not a tool, holder, fixture or evolving simulation result. Store the complete definition in the program so reopening needs no external setup file.

| Type | Required size fields | Meaning |
| --- | --- | --- |
| `box` | `width`, `depth`, `height` | Rectangular material, sized along local X, Y and Z. |
| `cylinder` | `diameter`, `length` | Solid round bar, with its axis along local Z before rotation; UI label: Round Bar. |

Both support `position:[x,y,z]` and optional `rotation:[rx,ry,rz]` using the same degree/rotation-order convention as tool parts. Zero position and identity rotation are schema defaults and may be omitted. Do not store a redundant radius alongside bar diameter. Tubular material with an inner diameter is a possible later extension, not part of the initial solid-bar type.

Define placement unambiguously: `position` locates the **centre of the material** in the program's initial work-coordinate system, not its minimum corner or a tool-local frame. Before rotation, a box occupies ±width/2, ±depth/2, ±height/2; a bar runs from -length/2 to +length/2 along Z. Rotation acts about this centre, then position translates it. No per-record `units` or `frame` field is needed because the versioned schema defines both conventions.

Examples for the setup block (alternative material definitions, not two simultaneous workpieces):

```text
; material={"type":"box","width":100,"depth":60,"height":20,"position":[50,30,-10]}
```

This box spans X=0..100, Y=0..60 and Z=-20..0: the program origin is at a corner of its top face.

```text
; material={"type":"cylinder","diameter":40,"length":100,"position":[0,0,-50]}
```

This bar is centred on X=Y=0 and extends from Z=-100 to Z=0: useful when the turning origin is at the front face. These are metadata examples, not machining instructions. Line wrapping must use the same safe continuation codec as tool records.

For future simulation, resolve the initial work-coordinate system to a fixed simulation/world transform at setup time. Subsequent G54/G55, G92 or other coordinate changes affect the toolpath interpretation, not the physical material position. Do not treat program coordinates as machine coordinates implicitly. If work-offset/kinematic transforms are unavailable, label the material preview as program-coordinate-only rather than claiming machine-space collision accuracy. All dimensions/positions remain mm, including lathe X placement: diameter-programming conventions must not double the physical material size or position.

The setup UI gains a **Material** section: None / Box / Round Bar, type-specific dimensions, XYZ centre position, optional rotation and a preview showing the origin/axes. A top-face/front-face placement helper can calculate centre position instead of requiring the user to calculate half-dimensions. Validate positive finite sizes, finite transforms and sensible bounds; missing material means no material-removal setup, not an automatically guessed workpiece. Material name/alloy and physical machining properties are deferred.

Committing the setup emits a proposed `PROGRAM_MATERIAL_UPDATE_REQUEST`, following the same revision-checked EventBus → metadata edit → reparse flow as tools and machines. Update only `material` in the managed SETUP block, preserving machine and tool data, in one undoable operation. Removing material removes that field; opening, plotting or restoring undo must not write it back. Machine comment-style conversion includes this field automatically. Existing backend requests stay unchanged until material support is explicitly implemented; storing/rendering a material box is not material-removal simulation.

Initial scope is one material definition per program. In combined multi-channel simulation, channel programs may contain copies of the same physical material for portability; do not render/remove material from duplicate copies independently without an explicit shared-material setup decision. Conflicting channel material definitions require review, never silent merging or duplication.

Tests: box/cylinder serialization, fixed-mm validation, centred bounds, rotations, front/top-face helpers, missing/removal behavior, preservation during machine-style conversion, manual edit and undo/redo synchronization, and conflicting multi-channel material. Later execution tests must cover work-offset transforms and turning diameter-mode conversion before material/tool intersections are considered accurate.

### Geometry naming and Three.js adapter conventions

Use plain, versioned JSON with a `type` discriminator, lower camelCase field/type names and named dimensions. Do not use `form`, `shapeType` and `type` interchangeably. Reserve `shape` for the insert outline code (C/D/V/etc.), while `type` identifies the geometry family (`insert`, `box`, `cylinder`, etc.). Uppercase insert letters are catalog identifiers, not class names.

**Canonical material types: `box` and `cylinder`.** Prefer geometry names over stock/product names: the UI can say "Round Bar", but JSON says `cylinder`, matching holder cylinders. This supersedes the earlier draft `bar` discriminator; no released implementation needs migration yet. Keep the requested top-level `material` key.

| Domain type | Three.js geometry mapping | Important conversion |
| --- | --- | --- |
| Material `box` | `THREE.BoxGeometry` | CNC width=X, depth=Y, height=Z → constructor arguments `(width, depth, height)`. Three.js names its arguments width/height/depth, so map explicitly. |
| Holder `box` | `THREE.BoxGeometry` | Local X/Y/Z sizes `(width, height, length)`; translate geometry by +length/2 along Z because holder parts start at z=0. |
| `cylinder` | `THREE.CylinderGeometry` | Both radii = diameter/2, axial size = length. Three.js cylinders are Y-axis aligned: bake a +90° X rotation to align +Y with domain +Z. Material stays centred; holder cylinders additionally translate by +length/2 in Z. |
| Holder `cone` | `THREE.CylinderGeometry` with unequal radii | Existing start/end diameters describe a taper/frustum; after axis alignment, bottom radius=startDiameter/2 and top radius=endDiameter/2. A true cone has one zero radius. |
| Revolved `profile` | `THREE.LatheGeometry` | Convert `[z,radius]` to the API's radial/axial profile points; align the generated Y axis to domain Z. |
| Cutting `insert` | `THREE.Shape` + `THREE.ExtrudeGeometry` | Generate the validated outline from shape/IC/dimensions/nose radius. Plain extrusion covers zero clearance; tapered side faces require custom geometry for positive clearance. |
| Drill/end mill/ball mill | Primitive assembly, lathed profile or custom `THREE.BufferGeometry` | Tool type is not one Three.js primitive; respect tip reference and distinguish cutting from non-cutting parts. |

Bake primitive-axis/origin conversions into the geometry once, then apply the domain part rotation and position to its mesh; apply assembly orientation separately. Use `THREE.MathUtils.degToRad()` for persisted degree values and match the documented extrinsic X→Y→Z convention (Three.js intrinsic Euler order `ZYX`, or an explicit Rz·Ry·Rx matrix). Never apply the axis correction as an additional user rotation or change the rest of the existing scene to compensate. Unit-test transformed bounds and reference points.

Persist only dimensions and transforms, not Three.js class names, Mesh/Object3D JSON, generated vertices, rendering materials or GPU resources. Keep tessellation, colours, opacity and render quality in renderer settings. Unsupported domain types must be diagnosed, not constructed dynamically from arbitrary class names.

Suggested TypeScript names for later implementation: `ProgramMaterialDefinition` (discriminated union of `BoxMaterialDefinition` / `CylinderMaterialDefinition`), `HolderPart`, `CuttingPart`, and `SimulationGeometryFactory` with `createMaterialMesh()`, `createHolderGroup()` and `createCuttingGroup()`. These are proposed contracts, not existing symbols. The factory returns Three.js objects; metadata/storage services remain independent of Three.js. It can compose the planned ToolGeometryFactory rather than putting domain parsing into PlotService.

Avoid confusion with `THREE.Material`, which means **surface appearance**, not the physical workpiece. Use `materialDefinition` for saved raw material, `workpieceMesh` for its scene object and `surfaceMaterial` for a Three.js rendering material. The existing PlotService line-material/cache properties do not need renaming just because the metadata gains `material`.

When integrating material/tool meshes into the current plot, give axes, toolpaths, workpiece and tools distinct group roles. Do not let the existing "toggle every non-toolpath group" axes behavior hide the new groups accidentally. Define fit-view/clear behavior explicitly and dispose owned geometries/rendering materials when replacing or removing preview objects.

## 5. Comment format

Use a namespaced, versioned, human-readable format. Add an explicit comment-writing capability to machine configuration and expose it through the machine API and MachineService:

- Supported standalone line prefix or block opening/closing delimiters.
- Preferred write style, allowed characters, maximum comment-line length when known, and valid header placement rules.
- Do not infer a writer from ACE highlighting regexes or assume parentheses are comments for every controller: Siemens commands can use parentheses as executable syntax.

Suggested version-one grammar: `@NCE-SIM:1 BEGIN SETUP`, `@NCE-SIM:1 BEGIN TOOL`, key/value records, and matching END markers. Each payload line is independently enclosed in the selected machine's comment syntax. Values are JSON scalars or arrays of typed geometry objects; the codec maps validated keys into typed objects. No evaluation of text or arbitrary object merging. The revised compact schema is still a proposal, so no released-format migration is implied.

Illustrative drill assignment for a profile that explicitly supports semicolon comments (not a runnable machining example):

```text
; @NCE-SIM:1 BEGIN SETUP
; machineName="SIEMENS_MILL"
; material={"type":"box","width":100,"depth":60,"height":20,"position":[50,30,-10]}
; @NCE-SIM:1 END SETUP

; @NCE-SIM:1 BEGIN TOOL
; toolNumber=1
; description="Drill 8 mm"
; holder=[{"type":"cylinder","diameter":8,"length":35,"position":[0,0,45],"stickOut":55}]
; cutting=[{"type":"drill","diameter":8,"length":45,"tipAngle":118}]
; @NCE-SIM:1 END TOOL
T1
```

Here cutting length includes the drill point; the non-cutting cylinder begins at z=45. Total modeled length is derived as 80, not duplicated as an overall-length field.

Turning geometry example (illustrative dimensions, not a verified holder/insert product or machine setup):

```text
; @NCE-SIM:1 BEGIN TOOL
; toolNumber=2
; description="D55 turning tool"
; Q=3
; R=0.4
; holder=[{"type":"box","width":20,"height":20,"length":100,"position":[0,-15,10],"stickOut":55}]
; cutting=[{"type":"insert","shape":"D","ic":9.525,"thickness":3.97,"noseRadius":0.4,"clearanceAngle":7,"position":[0,0,0]}]
; @NCE-SIM:1 END TOOL
```

The turning example shows the compact fields only: actual mounting/insert placement must be set in the preview editor before it is considered a complete assembly. Shape D supplies the 55° corner angle automatically. The top-level Q/R keys map to existing backend `qValue`/`rValue` fields; do not manufacture them for a drill that does not require compensation values. Full serialization includes every effective selected field, not library-dependent changes only. The same payload uses `(payload)` lines only on profiles explicitly supporting that style. Long array records require the continuation codec below when a controller line limit is exceeded.

### Codec and editing rules

- Escape controller comment delimiters, newlines, and unsafe characters inside strings (for example JSON Unicode escapes for parentheses). Never allow a description to terminate a comment and create NC code.
- Define deterministic numbered continuation records for values exceeding a profile's line limit; never split escape sequences or produce uncommented continuation lines. Bound decoded sizes and nesting.
- Version one stores one definition per tool identifier within a program/channel, immediately before its first recognized tool-selection command. Later uses resolve that same assignment. Reject conflicting duplicate definitions; operation-specific redefinitions need a later execution-aware model.
- Recognize tool calls using machine-aware parsing, not a global T-number replacement: account for named tools and combined tool/offset codes. No M6-dependent preselection workflow is used by this integration. Do not insert into text that merely mentions a tool inside another comment.
- Replacing a tool updates the existing managed block, rather than appending duplicates. A moved command requires a refreshed source range, not a persisted line number.
- User edits to managed comments are reparsed and validated. Malformed/unknown metadata is preserved and diagnosed, never guessed or silently rewritten.
- Apply only minimal text-range edits through the normal editor/document pathway in one undoable operation. Preserve unrelated comments, line endings and code. Opening or plotting a file must not silently rewrite it.
- Metadata contributes no NC tools, variables or keywords. Keep metadata recognition outside ordinary tool-token extraction.
- For execution, if the parser cannot safely ignore these blocks, replace recognized metadata lines with blank lines in the execution-only copy to preserve diagnostic and plot line numbers. Do not strip arbitrary parenthesized code.

## 6. Library versus program workflow

1. Create/edit a reusable tool in **Library** and save it locally.
2. Select a detected program tool and choose **Assign from Library**.
3. Copy the complete definition, edit program-specific orientation/Q/R/stick-out, and apply the comment block plus setup header as an explicit document edit.
4. Saving the NC file saves its simulation setup through the existing file workflow.
5. Reopening on a different computer reconstructs program tools without needing the library.
6. **Save Program Tool to Library** and **Update Program from Library** are separate, explicit actions with a comparison/confirmation when replacing data.

No implicit bidirectional synchronization. Program snapshots win over later library revisions. Deleting a library tool does not invalidate existing programs. Missing dimensions are shown as incomplete; never silently guess a simulation-ready geometry.

### EventBus-driven updates to program comments

Yes: applying edits in **Program Tools** or confirming a program machine change should update the managed simulation comments through EventBus and a single document-edit service. The UI never builds or replaces NC comments itself. Editing a library entry remains independent and only updates a program through explicit **Update Program from Library**.

Proposed flow:

1. A committed UI edit emits a typed `PROGRAM_TOOL_UPDATE_REQUEST` or `PROGRAM_MACHINE_UPDATE_REQUEST`. These are new proposed events, not existing functionality. Include document/program identity, expected document revision, origin (`user`), and request ID; machine requests also carry old and new machine names. Runtime routing IDs are still needed even though channel IDs are omitted from serialized comments.
2. `ProgramMetadataEditService` validates the request against the current document and resolves comment capabilities through MachineService. Tool requests update only the relevant managed tool block. Machine requests decode existing managed blocks using the **old** profile, update `machineName`, and re-encode the header and all managed tool blocks using the **new** profile's comment style, escaping, line limits and placement rules.
3. Apply minimal range edits through the normal ACE/VS Code document pathway as one undoable operation per document. Reject stale revisions rather than overwriting newer user edits. Emit an explicit success/failure result keyed to the request ID; the existing EventBus is synchronous notification, not an awaitable transaction mechanism.
4. After the edit succeeds, reparse the document and refresh program-tool state, the selected machine and previews. Existing `PARSE_COMPLETED` and `MACHINE_CHANGED` notifications may inform consumers, but generic state/parse notifications must not automatically trigger further writes.

For example, changing from a semicolon-comment profile to a parenthesized-comment profile rewrites only recognized `@NCE-SIM` blocks into independently wrapped parenthesized lines. It does **not** translate executable code or ordinary user comments. Warn that machine selection/comment conversion does not make an NC program compatible with another controller. If remaining code/comments cannot be validated under the new profile, require review before execution/transfer.

If either profile lacks safe comment capabilities, a block is malformed/unknown-version, or no safe insertion point exists, preserve the document and report why conversion cannot be completed. Do not discard old delimiters before extracting the metadata. Machine-profile capability changes without a user machine-selection action should mark metadata for review, not silently rewrite files on startup or refresh.

Because machine selection is currently global, confirm the affected loaded programs before applying a change across channels. Prevalidate the entire requested scope; do not silently edit unrelated files or advertise a successful global switch when one target failed. Multi-document host edits should be grouped where supported, otherwise report partial failures explicitly and keep the setup conflict visible.

Manual comment edits, file loading and undo/redo follow the reverse **read-only** path: document → parser → derived state → UI. Track origin/revision/request IDs, compare semantic values and avoid no-op rewrites so parse/update cycles cannot create an event loop. Saving remains the normal file-save workflow; updating a comment marks the document modified, not automatically saved to disk. Dispose EventBus subscriptions when views disconnect.

Acceptance tests: one Apply produces one edit and no event loop; Q/R/description/geometry round-trip; machine changes rewrite all managed blocks but preserve NC code and ordinary comments; old delimiters are decoded before conversion; undo/redo restores header/tool state and machine selection; unknown syntax, stale revisions, host failures and multi-channel conflicts cause no silent data loss.

## 7. Clean integration in this codebase

Existing integration points:

- [Tool UI](../src/components/NCToolList.ts): currently owns temporary Q/R inputs; change into a view over shared program-tool state.
- [Core contracts](../src/core/types.ts): retain current ToolValue backend compatibility; define richer tool contracts in a focused module rather than expanding PlotRequest indiscriminately.
- [Machine conversion](../src/services/MachineService.ts): carry explicit comment capabilities from server profiles.
- [Template repository pattern](../src/services/templates/ITemplateRepository.ts) and [catalog](../src/services/templates/TemplateCatalogService.ts): follow the separation of storage, domain operations and UI; do not put tools into the template schema.
- [Host bridge](../src/services/HostBridgeService.ts): typed requests/responses for library operations and active-document edits, with revision checks.
- [Execution](../src/services/ExecutedProgramService.ts) and [plot UI](../src/components/NCToolpathPlot.ts): collect resolved assignments through a service, not DOM queries into tool panels.

Proposed responsibilities (new modules, not yet created):

| Contract/service | Responsibility |
| --- | --- |
| `IToolLibraryRepository` | Host-specific persistence and import/export. |
| `ToolCatalogService` | CRUD, validation, revisions, filtering and immutable snapshots. |
| `SimulationCommentCodec` | Pure bounded parse/serialize, escaping, schema migrations and diagnostics. |
| `ProgramToolService` | Per-document/channel assignments, conflicts and derived state. |
| `ProgramMetadataEditService` | Thin metadata command coordinator/edit planner: validate snapshots, locate safe insertion points and request range edits through NCCodePane. Not another document writer or undo manager. |
| `toToolValues()` (execution mapping function) | Map complete program assignments into existing ToolValue Q/R request values with explicit validation/unit handling. No separate ToolExecutionAdapter service initially. |
| `ToolGeometryFactory` | Future deterministic Three.js meshes from validated parametric geometry. |

Register services centrally through existing ServiceRegistry/ServiceTokens. Use Web Components, EventBus, TypeScript and existing browser/Three.js APIs; no new frontend framework. Keep the backend stateless for personal libraries.

The extension source is not present in the explored workspace. Host filesystem persistence and contributed views require coordinated changes in that extension project; frontend messages alone cannot implement these capabilities.

### Current architecture audit and minimum integration

#### Tool-command syntax comes from backend machine information

Confirmed current flow: backend `list_machines()` adds `regexPatterns` via `get_machine_regex_patterns(machine["controlType"])` and exposes it through `/api/machines`. BackendGateway loads this response; MachineService copies `regexPatterns` into MachineProfile; NCCodePane passes the active profile's patterns to ParserService. ParserService uses `regexPatterns.tools.pattern` to detect tool commands (with a generic T-number fallback today).

Reuse this machine-provided pattern for program-tool discovery and metadata insertion anchors; do not create a separate hardcoded T-command regex in the tool manager or geometry factory. Relevant contracts already exist as `ServerMachineData.regexPatterns` and `MachineProfile.regexPatterns` in [core types](../src/core/types.ts). Backend patterns are currently selected by control type; extra machine-specific behavior must be explicitly represented if necessary.

Current limitations to address before relying on discovery for edits: ParserService takes only the first tool match per line, assumes numeric capture group 1 or T-style named syntax, and deduplicates into ToolRegisterEntry without preserving occurrence ranges. It scans raw lines, including comments. Add a shared, machine-aware token/occurrence result with exact identifier and source range, excluding comments/strings except recognized named-tool syntax. Validate regex/capture conventions. Generic fallback discovery must not be treated as verified syntax for automatic metadata edits when machine information is absent/invalid.

The tool regex answers **where/how a tool command is written**, not **which branch or loop occurrence executes it**. Keep those separate: source occurrences locate comment blocks; per-segment active tool IDs identify the tool for plot placement. Current tool calls update active state directly; no extra selection/activation protocol is required. Existing machine interfaces still lack safe comment-writing capabilities; add those through backend/profile contracts rather than inferring a comment writer from a highlighting regex.

Verified against the present implementation, not assumed from the proposed service names:

- [TemplateInsertionService](../src/services/templates/TemplateInsertionService.ts) gets a definition from its catalog and publishes `template:insert_request`. Its boolean return means the request was published, not that an editor/host committed it.
- [NCCodePane](../src/components/NCCodePane.ts) handles this in `applyTemplateInsert()` and synchronizes through `syncEditorValue()`: FileManager → StateService → `code-change` → parse. It already owns the ACE editor. Template insertion does not yet provide arbitrary revision-checked batched range edits.
- [VsCodeFileManagerService](../src/services/VsCodeFileManagerService.ts) forwards `updateActiveProgramContent()` through `syncToHost()` to `HostBridge.notifyDocumentChanged(channel, text, oldText)`. Host undo/redo updates return through `vscode:host-undo-redo` and `program:content_changed`. Reuse this route; do not notify the host a second time from a metadata service.
- [StateService](../src/services/StateService.ts) manages application/channel state and history. `setGlobalMachine()` sets the name/profile and publishes `MACHINE_CHANGED`. It does not parse/write simulation comments or transact machine selection together with document edits. Application-state history is not a replacement for document undo.
- [HostBridgeService](../src/services/HostBridgeService.ts) currently supports outgoing document-change notifications/workbench relay and incoming undo/redo. It has no tool-library load/save RPC, document revision acknowledgment or tool-panel edit routing yet.
- [main.ts](../src/main.ts) registers host-specific file managers, but registers WebTemplateRepository for templates regardless of host mode. Follow the repository abstraction, not the assumption that templates already implement host-owned JSON storage. Every separate webview has its own ServiceRegistry/EventBus; publishing an event does not cross into another view.
- [ExecutedProgramService](../src/services/ExecutedProgramService.ts) accepts `ExecutionRequest.toolValues` and forwards them to BackendGateway for both single/multi-channel execution. It does not obtain these values from geometry or a catalog. NCToolpathPlot currently obtains tool overrides from the UI; replace that dependency with program metadata state.

#### Is ProgramMetadataEditService necessary?

**The metadata-editing responsibility is necessary; a second general-purpose edit service is not.** Keep this proposed service small, similar to TemplateInsertionService, because three operations share the same policy: tool assignment, machine/comment conversion and material updates. None of these policies belongs in StateService, ToolCatalogService or HostBridge.

It receives a domain request and a current document snapshot, uses the pure SimulationCommentCodec to decode/encode managed blocks, and generates an edit plan. NCCodePane applies that plan via a small new `applyProgramEdits()` handler (proposed name), batching range replacements and syncing the final text once through the existing file-manager route. Preserve cursor/selection where possible and group web ACE undo; VS Code undo remains host-owned. Suppress intermediate change callbacks only during that explicit batch, then publish one final document update.

ProgramToolService supplies derived per-program setup/tool state; extend its snapshot to include machine/material rather than creating a second store for the header. It must not become an independent source of writable metadata. State reads come from parsed document revisions. The coordinator can be renamed ProgramMetadataService later if that better expresses its scope; do not add both classes with overlapping responsibilities.

#### Connections: catalog, events and host

Library path (no NC document changes):

`Tool Manager → ToolCatalogService → IToolLibraryRepository`

- Web repository: validated JSON in localStorage.
- VS Code repository: typed request through HostBridge → extension-owned JSON storage → acknowledged response. Add correlated request IDs, revisions and failures; do not treat postMessage as a successful save. Bridge replies resolve repository promises, and catalog success publishes a local `TOOLS_CHANGED` notification. The host separately broadcasts library revision changes to other views, which invalidate/reload their catalogs.
- ToolCatalogService knows tool identity/revisions/validation, not ACE, NC comments, Three.js or VS Code APIs. It depends on the repository interface, not HostBridge directly. HostBridge transports validated messages and knows no tool geometry rules.

Program path in web/editor mode:

`Tool Manager → committed domain request → ProgramMetadataEditService → edit-plan event → NCCodePane → FileManager → existing host route if applicable → reparse → ProgramToolService → UI`

Assigning from the catalog first resolves the chosen tool ID/revision and copies a complete snapshot into the request. Later library edits do not change that snapshot. Direct program tool edits need no catalog lookup. Requests for machine/material changes use the same planner but do not go through ToolCatalogService.

Program path from a separate VS Code tool view:

`Tool view → HostBridge → extension routes to owning editor/document → editor EventBus → same coordinator/edit path → correlated result back to tool view`

Do not create a fake editor in the tool view or address a document by channel alone. Host routing must provide the owning document identity and revision; the current channel-only messages are insufficient for multiple open editors. If no eligible editor owns the document, report it rather than silently editing a different one. Native-text-editor support would need an explicit extension-side document adapter, not an additional parallel writer in this frontend.

Use direct async methods/promises for catalog/repository work; use EventBus for UI requests and notifications. The existing EventBus is synchronous and does not await async subscribers. Add explicit request/result contracts for edits, including rejection when there is no target, stale revisions, or failed host application. New bridge operations and events are proposals and require host integration.

For machine selection, replace the user-action path to direct `setGlobalMachine()` with a validated metadata-change request. Retain the old profile until conversion planning succeeds; commit state after successful document application. Keep `MACHINE_CHANGED` as a notification for parser/highlighting/workbench consumers, never a blanket trigger to rewrite files. Loading and undo/redo must restore derived selection without introducing new edit/history cycles. Transactional global/multi-document behavior still needs explicit implementation and tests.

#### Execution mapping versus geometry factory

**ToolExecutionAdapter must not be integrated into ToolGeometryFactory.** These are two independent consumers of the same parsed snapshot:

- Execution: `ProgramToolService snapshot → toToolValues() → ExecutionRequest.toolValues → ExecutedProgramService → BackendGateway`.
- Preview: `ProgramToolService snapshot → ToolGeometryFactory / SimulationGeometryFactory → Three.js objects`.

Initially implement `toToolValues()` as a pure, separately tested function near the execution/domain boundary, used for both single- and multi-channel requests. Preserve numeric/named tool IDs and zero Q/R values, reject invalid values, and omit undefined overrides. Map stored Q/R to backend `qValue`/`rValue`; do not derive R from insert/cutter geometry unless explicitly requested under verified machine rules. Do not recompute compensation paths in the browser: the execution engine already handles compensation.

This function requires no EventBus, HostBridge, catalog lookup or Three.js dependency. Only promote it into a dedicated adapter class if multiple backend contracts or substantial machine-specific conversion policies justify that abstraction. ToolGeometryFactory creates shapes, placements and meshes; it neither serializes backend requests nor writes comments. This separation allows execution without WebGL and previews without a running backend. Keep material metadata local to setup/preview until the backend explicitly supports it.

### Editor position → plot position → active tool

Use EventBus for selection notifications, not for repeatedly transporting complete geometry definitions. The selected execution segment links the source code, coordinates and tool identity. A point `[x,y,z]` alone cannot identify a tool, because several tools/iterations can visit the same position.

#### What exists today

- NCCodePane emits `EDITOR_CURSOR_MOVED` with channel and a 1-based line number.
- NCToolpathPlot subscribes and calls `highlightSegment()`; for verified poses it
	also places the run-owned milling tool mesh at the selected pose.
- ExecutedProgramService maps backend segment points into PlotSegments and already preserves optional `toolNumber`, `channelId` and source line numbers on endpoints. Each adjacent pair of backend points becomes one rendered segment.
- Current points are deduplicated by coordinates in the point collection. Use ordered segment identity, not the deduplicated point index, for playback/selection. Repeated visits to an identical point must remain distinct execution occurrences.
- `PlotSegment.toolNumber` and the backend-response mapping now preserve numbers, named strings, null and missing values, alongside `executionStep` and response/subsegment indices. Exact run-owned numeric tool lookup and milling placement are implemented; named-tool placement remains subject to the backend pose contract. Missing tool metadata is not a signal to use the first tool in the catalog.

#### Retain a snapshot with each plotted execution

At request creation, capture the exact program text/revision, machine/profile context, fixed `toolPathMode: 'center'` and complete resolved program-tool definitions used for the request. Assign a `runId`. Store this immutable context alongside the execution result; do not resolve a past plot against a newly edited program or a changed library entry.

Proposed `PlotRunSnapshot` owns:

- `runId`, document/program identity, revision and channel identity per source program.
- Machine and coordinate/tool-reference conventions for interpreting returned poses.
- Ordered rendered segments with run-scoped `segmentId`, original backend-segment ordinal and subsegment index; preserve execution order when tessellating arcs.
- Source locations indexed to **lists** of segment IDs (line/column where supported, program identity and execution occurrence).
- Complete tool snapshots indexed by the scoped exact tool identifier, plus material/setup context. Tool number 1 in another channel is not the same assignment automatically.

The updated backend API supplies the active tool for each move. Tool calls update active tool state directly in this integration; there is no M6 requirement. Textual T-code order alone remains insufficient for macros, loops and conditional execution. If execution metadata is absent, retain highlighting but show "active tool unavailable" and hide the tool mesh; do not guess from the nearest preceding text line.

#### Decision: execution-owned active tool in the plot API

Make the backend authoritative for the active tool at every generated movement. The engine captures the active tool **at the moment it emits each plot entry**, after the controller has applied any relevant activation and before later commands mutate state. It must copy the identifier into the entry, not keep a mutable state reference or annotate all entries with the tool active at the end of the run.

The updated API uses `segments[].toolNumber` for the **active tool for that movement**: a number, named-tool string, or the reserved string `"unknown"`. Treat `"unknown"` as unavailable metadata, never as a catalog lookup. A real named tool literally called "unknown" is ambiguous under this API; reserve that name until a future explicit status field resolves the collision. No `toolState` or preselected-tool field is required by the current API. Preserve zero IDs without truthiness checks; do not assign universal unload semantics to T0.

Local backend adapter updated to match the supplied CGI (2026-09-11): [backend/main_import.py](../backend/main_import.py) now forwards `entry.get("toolNumber", "unknown")` and `entry.get("executionStep")` instead of synthesizing tool 1. `executionStep` is a zero-based executed-command occurrence per channel; generated cycle segments share their parent command's step. Missing steps remain null, not an invented plot-array index. Like the supplied CGI, an explicitly null tool field is passed through; clients should treat null/missing values as unavailable too.

Adapter regression tests cover numeric/named tools, zero tool/step, shared and repeated steps, unknown/missing/null metadata and independent conversions. Actual engine capture semantics still require end-to-end verification against the installed updated ncplot7py version. The local adapter deliberately retains its existing geometry/traversal contract and does not add the CGI's legacy timing-based `type` inference. The frontend now preserves these identifiers and executionStep through subsegment creation without carrying missing tool state forward. Unknown-tool lookup/placement handling remains part of the planned run resolver. Client run-scoped segment IDs can be derived from response ordinal plus subsegment index; executionStep alone is not unique per segment. `segmentId`, `toolState` and `executionMode` from earlier proposals are not supplied by the updated CGI and must not be assumed to exist.

Preserve this captured ID for all primitive moves produced by a cycle and all frontend subsegments produced from a sampled arc. Channel identity plus execution occurrence/segment ID and source location establish the lookup scope. Do not replace the existing numeric `executedLines` list with objects without versioning: adding active tool to motion segments is the minimum compatible contract. If tool pose on a non-motion executed command is needed later, add a separate ordered `executionSteps` trace with step ID, source location, active tool and position/state; a source line number alone cannot identify loop iterations or subprogram calls.

Frontend behavior under this decision:

- Typing or editing tool/machine/material comments does **not** run execution or calculate a new moving-tool pose. Parsing may update lists and the tool manager's static shape preview, but the main plot remains the last completed run and is marked stale when its input changes.
- An explicit Plot action requests centre mode and captures the corresponding complete program-tool snapshot. The completed response supplies movement coordinates and active tool IDs; the frontend resolves those IDs against that captured snapshot, not against today's edited library/program.
- Cursor movement over an unchanged executed revision or plot playback only selects an existing segment and moves a cached mesh. This is display of already executed data, not re-execution. On a stale revision disable editor-follow placement; retained run playback can still use its own snapshot.
- Send tool definitions once per run context (client-owned snapshot initially), not on every point. Return the full definition from the backend only if it is authoritative for resolving/altering it; any effective Q/R or reference changes made by execution need explicit per-step data rather than silently using static defaults.
- Missing/legacy/mock tool IDs disable accurate tool placement while leaving the path visible. Mock execution must be explicitly identified by the response before its results can be treated as an execution trace; the attached CGI currently permits mock fallback, so a successful response alone is insufficient proof.

Integration fixtures must execute two or more different tool calls (without M6) and verify IDs on every intervening move, not only tool-call lines. Cover named tools, generated cycle moves, no initial tool, supported unload/reset behavior, branching/repetition, and separate channels. Verify both deployed adapter paths preserve the same engine values and never synthesize tool 1.

**Last-tool rule:** each motion uses the most recent **executed tool call in that channel**, until the next tool call or an engine-defined unload/reset. Do not wait for M6 or maintain a separate pending-tool model in the frontend/adapter. An offset-only change is not necessarily a different physical tool. Respect the engine's execution order within a block that both calls a tool and moves.

The execution engine should carry this modal active tool through every move and return its identifier on each segment, even when that move contains no T command. Normalize this into the stored run trace; cursor navigation then looks up the selected segment directly rather than scanning backward on every cursor move. If the backend emits sparse tool IDs, carrying the previous one forward is valid only when its contract guarantees that omission means unchanged and that all activation/unload events are represented. Otherwise missing tool state is unknown, not evidence that the previous tool is still active.

Do not infer an initial tool before its first known activation. Do not leak tool state between runs/channels. Include activations inside loops/subprograms and ignore nonexecuted branches; the last textual T command above a line is not necessarily the last executed tool call.

#### Proposed selection and pose contracts

Keep input **selection** separate from output **resolved pose**:

| Contract | Fields / purpose |
| --- | --- |
| Extended editor cursor event | Document/program identity, revision, channel, 1-based line/column, origin and request ID. Existing channel/line-only events need compatibility handling. |
| `PLOT_SELECTION_REQUEST` | `runId`, `segmentId`, `fraction` (0..1), origin (`editor`, `plot` or `playback`) and request ID. Used for graph clicks/scrubbing or after resolving a cursor location. |
| `ResolvedToolPose` | `runId`, selected segment/source identity, tool-snapshot key, position `[x,y,z]`, orientation quaternion `[x,y,z,w]`, and validity/approximation status. An internal renderer contract, not additional NC-comment fields. |
| `PLOT_SELECTION_CHANGED` | Selected run/segment/source and resolved pose/status for views that need it. No full library or Three.js objects in this notification. |

Prefer segment ID plus fraction over accepting an arbitrary XYZ point: it carries execution provenance. A plot raycast can return a line-object segment mapping and fraction. The current rendering batches lines by motion type; maintain a mapping from rendered line-pair index to run/segment ID rather than assuming rendered order equals overall execution order.

For a linear subsegment, position is `start + fraction * (end - start)`. For the current sampled arc representation, this interpolates its small straight subsegment and is only as accurate as backend sampling. Exact arc interpolation and time-accurate animation require additional curve/timing information. Current line-aggregated timing is not enough for a precise repeated-occurrence playback clock.

#### Minimal implementation path

1. Extend execution-result ownership with PlotRunSnapshot. Initially place source/segment lookup and `resolveSelection()` in a small pure helper used by ExecutedProgramService/the plot component, rather than registering a large playback service prematurely.
2. On editor cursor movement, resolve the source location against the displayed run. Default to the end (`fraction=1`) of the last subsegment of the selected execution occurrence; keep the occurrence explicit. If a line executes repeatedly, prefer the current playback occurrence or present an occurrence selector. If none was selected, use the first occurrence with a visible occurrence indicator, not a hidden assumption that the line executes once.
3. For non-motion lines or unexecuted branches, show "no plotted move for this location" and hide the cursor-follow tool initially. Do not pretend a nearby motion point belongs to the selected line. A later execution trace can support accurate state on dwell/tool-change lines.
4. Resolve the segment's active tool ID against **that run's copied program-tool definitions**, never against ToolCatalogService. A missing definition produces a clear diagnostic while the toolpath remains visible.
5. ToolGeometryFactory builds/caches a tool assembly whose origin is the documented active reference tip. NCToolpathPlot attaches it to a dedicated tool group, sets position/orientation, and renders. Move the existing mesh when only selection changes; rebuild only when its geometry snapshot changes, with correct cache ownership/disposal.
6. ToolGeometryFactory consumes the resolved definition and transforms, but does not subscribe to editor events, find source lines or discover active tools. A future PlaybackService can own selection/time advancement when animation is added, reusing the same resolver and pose contract.

Full flow:

`EDITOR_CURSOR_MOVED → source/occurrence lookup in PlotRunSnapshot → selected segment → active tool key → run-owned tool definition → pose resolution → NCToolpathPlot + ToolGeometryFactory`

Plot clicks and playback feed the same selection resolver. If a plot click also moves the editor cursor, propagate origin/request ID and suppress the resulting echo; do not start another plot or reset the chosen execution occurrence.

#### Position and orientation correctness

**Decision: always request `toolPathMode: 'center'` for plotting and tool placement.** The backend calculates the centre/reference path; the frontend does not calculate an effective contour, offset the path using tool radius, or switch between competing placement paths. This supersedes the earlier design allowing an effective/centre plot choice.

Implemented: centre mode is enforced at the shared plot-request construction boundary for both single- and multi-channel execution, not only as a dropdown default. The effective-mode plot toggle is removed and old persisted plot settings normalize to centre mode, including undo/redo restoration. Legacy API mode arguments remain accepted for caller compatibility but are ignored; all application plot calls use centre mode.

Verify the backend's exact centre/reference convention and align the tool mesh origin once: a turning insert nose centre, virtual tip and milling cutter reference tip are not interchangeable. A centre-path request alone does not supply a complete multi-axis pose or define those conventions. Do not add compensation twice. If the selected backend/machine cannot provide the required centre/reference path, report placement unavailable rather than silently falling back to an effective contour.

The attached external CGI API documentation explicitly says `center` and `effective` currently return the same coordinates, with their distinction reserved for later G41/G42 interpolation. Therefore always requesting centre mode expresses the intended contract; it does **not** prove that compensated centre coordinates are implemented yet. Verify the deployed engine with known compensation fixtures before claiming accurate compensated tool placement. The same attachment contains older validation/preprocessing descriptions that differ from the supplied CGI source; treat actual deployed code and contract tests as authoritative, and reconcile documentation before integration.

The backend currently returns XYZ points, not a general multi-axis tool pose. For a verified fixed-orientation machine, combine the stored assembly orientation with the known machine/work-frame transform once. Do not orient a milling cutter along the path tangent. Dynamic rotary-axis/multi-axis orientation and turning Q-to-tip rules require explicit execution/kinematics support, not inference from XYZ. Convert positions into the same scene space as the rendered path/material and maintain fixed-mm conventions. Orientation quaternions in ResolvedToolPose are runtime values; stored metadata still uses the agreed degree rotations.

When program/tool/machine/material edits change the revision, mark the displayed run stale. Disable editor-to-old-run placement until re-execution (or an explicitly verified source map) instead of matching shifted line numbers. The old run can remain viewable through its own plot selection and immutable geometry snapshot. Ignore late results/selections for a run that is no longer displayed.

Separate VS Code editor/plot views need explicit HostBridge messages for selection and the run/source context. The current workbench execution relay sends variables/errors, not plot segments or tool definitions, so this is new functionality. Send the run snapshot once or expose it through a host-owned store; send only run/selection identifiers on cursor movement. EventBus alone does not cross webview boundaries.

Acceptance tests: every single/multi-channel plot request uses centre mode despite legacy settings; last executed tool call persists through moves without tool commands; direct tool activation, supported unload/reset and same-block execution order are honored; repeated lines/subprograms use execution order; initial unknown/missing tool state is diagnosed. Also test same XYZ with different tools, named tools, missing definitions, first/last subsegment selection, arc sampling, fixed-orientation placement, centre-to-mesh reference mapping, stale revisions/out-of-order results, independent channels/runs, plot-click/editor echo suppression, and geometry reuse/disposal. Highlighting should continue to work when accurate tool placement is unavailable.

### Concrete frontend implementation sequence after the backend update

This is the implementation specification for the frontend work. Section A and shared centre-mode enforcement are implemented. Sections B/C now have same-view editor Plot integration as summarized above, conditional on explicit metadata read capability. Sections D–F, host revision/edit contracts and safe header capabilities remain proposed. Keep the early milestones small: preserve execution metadata and test lookup before adding meshes. The local backend forwarding is already implemented; no more source-code tool scanning should be added to the plot.

#### A. Preserve the updated API fields — implemented

Implemented with `BackendPlotSegment` / `BackendPlotChannel` contracts and regression coverage in the execution tests. The requirements below describe the delivered behavior; no run-store or selection functionality is implied.

In [core types](../src/core/types.ts), extend `PlotSegment` with optional `executionStep: number | null`, `sourceSegmentIndex: number`, and `subsegmentIndex: number`. Widen `toolNumber` to `number | string | null`; retain optionality for legacy responses. These added indices are client metadata, not required backend fields. Define the corresponding raw response segment interface once rather than leaving the numeric-only inline type in ExecutedProgramService. The literal string `"unknown"` is the API's reserved unavailable-tool sentinel, not a real library key.

In [ExecutedProgramService](../src/services/ExecutedProgramService.ts), copy tool identity and executionStep onto **every** generated PlotSegment. Source-segment index is the original response-array ordinal; subsegment index is the adjacent-point-pair ordinal. Preserve executionStep=0 and numeric tool=0. Do not use `executionStep || index`, parse named tools as integers, carry missing IDs forward, or deduplicate occurrences by XYZ. Existing geometry/traversal filtering is independent; support for unclassified paths is separate from this metadata-preservation change.

Add fixtures in [execution tests](../src/services/__tests__/ExecutedProgramService.test.ts): numeric and named tools, unknown/null/missing IDs, step zero, repeated source lines, multiple cycle segments sharing a step and multiple sampled pairs from one arc. Assert the metadata remains attached after channel results are combined.

#### B. Capture program tools once, before execution

Integration status: `ProgramToolService.captureProgramSnapshot(identity, revision, text, syntax?)`, `SimulationCommentCodec`, domain validation and `toToolValues()` are centrally registered and used by editor Plot. Capture itself remains read-only. Explicit syntax transport, bounded run context/storage, completed-run event ownership, DOM-lookup replacement, and revision-checked `TOOL`/`OFFSETS` metadata edits are implemented. Deployment capability advertisement and extension-host-owned document revisions remain pending. Optional lengths/edge geometry stay client-owned and are loaded only at this explicit Plot boundary.

Add a proposed `ProgramToolService.captureProgramSnapshot(programIdentity, revision, text)` returning a detached, validated snapshot of parsed program tool definitions, machine and material. It must parse/validate the exact supplied text or prove that its cached parse matches that revision; do not take a possibly stale asynchronous parse. It needs no catalog lookup: assigning a library tool has already copied the definition into the program.

Extend the execution entry point to accept a client-only run context for all selected programs, with `runId` and immutable snapshots. Register new domain services centrally in [main.ts](../src/main.ts) and [service tokens](../src/core/ServiceTokens.ts); do not instantiate them in individual views. Initially keep run contexts/results in ExecutedProgramService rather than creating another global run-store singleton. Expose proposed read-only `getPlotRun(runId)` / `getRunTool(runId, programId, channelId, toolNumber)` accessors. Their storage must be bounded and released when runs are discarded; TypeScript readonly alone is not protection against mutating shared references.

Use nested maps keyed by program/channel and the exact numeric-or-string identifier (or collision-safe serialized tuple keys). Do not concatenate ambiguous strings or collapse numeric `1` into named `"1"`. Never look up `"unknown"`, null or undefined. Normalize incoming values once at the API boundary only according to documented identifier semantics.

In [NCToolpathPlot](../src/components/NCToolpathPlot.ts), replace the `nc-tool-list.getToolValues()` DOM query in `plotNCCode()` with `toToolValues(snapshot.tools)`. Get the exact program from the existing document/file-manager path, including pending editor changes, and use that same text for snapshot capture and execution. Preserve the custom-variable inputs but copy them into run context too. Missing geometry does not prevent existing Q/R-only programs from plotting; it prevents tool mesh creation with an explicit unavailable-definition status.

Enforce `center` in the shared single/multi-channel request construction path. Keep complete geometry/run context on the client; BackendGateway sends only the existing supported request fields, not the new run-store objects.

#### C. Publish one completed run to the plot

Implemented for same-view editor Plot by `executePlotRun()` and `PLOT_RUN_COMPLETED`. The following requirements describe that path; separate webviews and legacy direct execution callers are not automatically connected to the run store.

Add proposed `PLOT_RUN_COMPLETED` to [EventBus](../src/services/EventBus.ts), carrying `{ runId }` within one application instance. Store the completed run before publishing. For global multi-channel plotting publish once after the requested result set is assembled; for a channel-header Plot publish once for that single-channel run. Preserve existing per-channel `EXECUTION_COMPLETED` events for variables/errors/executed-line consumers, optionally adding runId for correlation.

Change the plot to render from `getPlotRun(runId)` in one event handler. The current code both subscribes to execution completion and directly calls `updatePlot()` after combining awaited results; remove that duplicate plot-update path when adopting the run event. Do not render each per-channel completion and then overwrite it with a combined result. A promise remains useful for request failure/busy handling, but must not cause a second render of the same run.

Keep current displayed run ID plus a request generation marker. Ignore late/superseded completions. A failure must not leave a partially updated tool snapshot attached to another run's paths. Derived parse changes mark old runs stale; only explicit Plot requests create new runs.

#### D. Resolve an editor selection without executing anything

Reuse `EDITOR_CURSOR_MOVED`, extended with document/program identity and revision. Add a pure `resolvePlotSelection(run, sourceLocation, preferredExecutionStep?)` helper returning selected segment identity, fraction, and status. Build its index once per run rather than scanning every segment on every keystroke.

Within the displayed run, group matches by channel/program and executionStep. The default selection is the last subsegment endpoint of the chosen command occurrence; if no occurrence is selected, select the first matching executed occurrence and indicate that choice. Multiple primitives sharing the same step form one occurrence. For legacy missing steps, use original response segment identity as a limited fallback and mark occurrence grouping unavailable; never merge all null steps into one command.

From that selected segment resolve its tool via `getRunTool()`, producing a `ResolvedToolPose` only when tool/reference data is sufficient. Move the mesh directly in the plot handler, then optionally publish `PLOT_SELECTION_CHANGED` for other consumers; do not subscribe the plot to its own notification and create an echo. `PLOT_SELECTION_REQUEST` feeds this same resolver for plot clicks and later playback. Requests carry runId, segment identity, fraction, origin and correlation ID, not complete tool arrays.

On stale source revisions, unknown tools, missing geometry or unexecuted lines: hide the cursor-follow tool and show the reason; keep valid path highlighting where source mapping is still valid. Unknown tool metadata does not trigger a catalog fallback. No network requests, program edits or execution calls occur during selection.

#### E. Draw and move the tool

Keep [PlotService](../src/services/PlotService.ts) responsible for path geometry/materials. ToolGeometryFactory (proposed) builds holder/cutting meshes from the saved definition; it has no EventBus or HostBridge dependency. NCToolpathPlot owns a dedicated `toolRoot` and calls a proposed `showToolAtSelection()` using the resolved definition/pose. Cache geometry per immutable definition within a run; do not cache by tool number alone across runs. Moving a selection changes only root position/quaternion. Switching tools reuses/builds the corresponding assembly, preserving geometry-local transforms.

Attach scene roles to groups (`axes`, `toolpath`, `tool`, `material`, `highlight`) and explicitly update `clearPlot()`, `toggleAxes()`, visibility and camera-fit behavior so adding a new group cannot make it act like axes. Include tool/material extents in Fit only according to an explicit UI policy; cursor-follow movement must not refit the camera every time. Dispose owned geometry and surface materials on replacement, clear and disconnect; retain and unsubscribe EventBus subscriptions. Keep per-channel tool roots only if simultaneous channel visualization is deliberately enabled; initial cursor-follow can show one selected tool.

For raycast selection later, retain response/subsegment identity for each line pair when createSegmentedToolpath() batches by motion type. The render order is not the execution order. Accurate placement remains gated by backend centre/reference and orientation conventions described above; a mesh preview alone is not collision/material-removal simulation.

#### F. HostBridge only when the views are separate

The web app and editor-hosted plot share a local EventBus and can read the same run store directly. No bridge round trip is needed for them. A separate VS Code plot/tool view has a different store; `{ runId }` alone is insufficient there.

Extend [HostBridgeService](../src/services/HostBridgeService.ts) with typed, validated run-snapshot transfer/request and selection envelopes only when adding that separate view. Send a JSON-safe completed snapshot once per run (maps as entries/records), install it in the receiving store, then notify its local EventBus. Subsequent cursor/playback messages contain only run/source/selection IDs. Route through the extension to the owning document, validate revision/correlation, prevent relay echo, and reject selections for missing snapshots. The current variables/errors-only execution relay cannot supply a tool definition; do not pretend it already does. Reusing a host-owned snapshot store is an alternative to repeated transfers, not an excuse to expose arbitrary filesystem paths.

#### Delivery checklist

1. Frontend response/type preservation tests pass without requiring WebGL.
2. Metadata codec/program snapshot and Q/R projection tests pass; run context remains unchanged after user edits.
3. Both single/global Plot paths create exactly one completed run render in centre mode.
4. Selection tests resolve the correct program/channel/tool/occurrence, including unknown and stale cases.
5. Three.js geometry tests verify reference-point placement, mesh reuse and resource cleanup without depending on a browser renderer.
6. Browser checks verify cursor-follow, tool switching and no backend calls while editing or selecting; use a fake backend fixture if the live engine is unavailable.
7. Separate-view transport tests are added with the extension changes; this does not block the initial same-view web implementation.

## 8. Tool manager UI

Reuse one Web Component in a web sidebar and a VS Code WebviewView, similar to Templates. Users can move the contributed view into VS Code's secondary/right sidebar.

- Tabs: **Library** / **Program Tools** / **Offsets**.
- Search/filter by tool type and machine compatibility.
- List with original schematic icons and name/dimensions; avoid copying manufacturer product images without permission.
- Editing sections: General, Geometry, Holder/Mounting, Compensation (Q/R), Preview.
- Program setup section: machine and optional Material (Box / Round Bar), dimensions, XYZ centre position and rotation; separate from the reusable tool library.
- Geometry editors show **Holder parts** and **Cutting parts** as add/remove/reorder lists with type-specific named fields, not raw JSON. Stick-out is edited in the Holder section and stored only on its first part; reordering transfers this assembly setting to the new first part.
- Turning selector shows original outline icons for C/D/V/W/T/S/R and the extended shapes listed above, with derived corner angle, editable IC/dimensions, thickness, nose radius and clearance. Separate presets cover grooving, parting, threading and custom profiles.
- Context-sensitive fields: drill length/tip angle versus turning nose radius/orientation, for example.
- Clearly label dimensions as mm and rotations as degrees; distinguish IC from cutter diameter and nose radius. No per-tool units or frame selectors.
- Program rows show channel/tool identifier, complete/incomplete status, source revision and library differences.
- Start with original SVG diagrams and parametric previews; custom revolved profiles can be embedded completely. Large external meshes are deferred because a path/reference alone is not a self-contained NC program.

## 9. Implementation stages and acceptance tests

1. **Contracts and dialect capabilities:** agree schema, geometry frames, supported tool IDs, units and actual ncplot7py Q/R semantics. Verify machine configuration and header-placement behavior.
2. **Persistence and codec:** library repositories, import/export, migrations, pure comment parsing/writing, unknown-version preservation. Test delimiter injection, Unicode, long lines, corrupt data and storage failures.
3. **Program integration:** assignment state, setup restoration, single undoable metadata edits and independent-file reopening. Test CRLF/LF, repeated/named tools, duplicates, unsaved edits, undo/redo and multi-channel split/join.
4. **Shared tool manager:** library/program tabs, geometry forms and original schematic previews; extension-host adapter and dockable view in the extension project.
5. **Execution compatibility:** derive Q/R from shared state without changing current backend geometry support. Test payloads, unit conversions, existing programs without metadata and unchanged line mapping.
6. **Future simulation:** execution-aware turning tool activation and machine-reference poses; material removal/collision checking is a separate project, not achieved simply by storing or previewing geometry.

Geometry tests must cover each listed supported shape (especially W versus T), IC scaling, rounded tips, positive clearance, explicit part transforms, stick-out placement, and preservation of custom/unsupported types without silently substituting geometry. Validate nonnegative radii, positive dimensions, plausible corner-radius limits and schema defaults. Test omission of channel/units/frame fields, fixed-mm import conversion, and isolation of identical tool numbers in different programs.

Round-trip criterion: save an NC program, remove access to the local library, reopen it, and recover every supported tool field and the selected machine name exactly. A machine profile still needs to be installed/available. No simulation result guarantees safe machine operation.

## 10. Research references

Reviewed 2026-09-11:

- [CAMotics](https://camotics.org/): tool table editing and parametric cutter shapes illustrate a useful first UI scope. Its stated 3-axis/lathe/collision limitations reinforce separating previews from full machine simulation.
- [CAMotics tool-view screenshot](https://camotics.org/images/screenshots/tool_view.png): external UI reference, not an asset to copy into this application.
- [LinuxCNC tool compensation](https://linuxcnc.org/docs/html/gcode/tool-compensation.html): separates tool number, pocket, length offsets, diameter, lathe angles, orientation and description. Its Q convention must not be assumed to match every machine.
- [Sandvik Coromant: choosing a turning insert](https://www.sandvik.coromant.com/en-us/knowledge/general-turning/how-to-choose-correct-turning-insert): distinguishes insert shape, size, nose radius, positive/negative clearance, entering angle and wiper geometry.
- [Carbide Depot: insert designation chart](https://www.carbidedepot.com/formulas-insert-d.htm): public shape/angle and clearance tables, plus ANSI/ISO size distinctions. Extended catalog entries are not treated here as proof of exhaustive ISO-standard coverage; confirm supplier dimensions for actual products.
- [VS Code ExtensionContext](https://code.visualstudio.com/api/references/vscode-api#ExtensionContext): globalStorageUri for extension-owned library persistence; workspace.fs for URI-based file access.

These references inform the architecture; the namespaced comment format above is an NC-Edit7 proposal, not an existing CNC interchange standard.

## 11. Minimal machine and tool visualization plan

Research and design update: 2026-09-14. This section specifies future work, not
implemented machine profiles, renderer features or verified ncplot7py kinematics.
No production machine configuration or external engine repository was modified
for this plan. Earlier generic XYZABC and universal STAR range examples are
superseded by the explicit frame contract and model-specific restrictions here.

### 11.1 Decision: a workpiece view, not a machine digital twin

Start with the executed tool-reference path, one selected tool/holder mesh,
coordinate axes and optional initial material. Keep the workpiece stationary in
its own frame. No machine enclosure, moving spindle housing, turret body, chuck
collision model or transfer animation is needed for this first display.

The user is right that much of the machine geometry is unnecessary **when the
position is already the correct tool-reference position in the workpiece frame**.
The producer then supplies the corresponding orientation. The renderer does not
need pivot distances to place that resolved pose. Those distances may still be
necessary upstream to convert raw machine positions into workpiece coordinates.

| Input available | What we can honestly display |
| --- | --- |
| Existing XYZ path and active tool ID only | Path, highlight and static local tool preview; no claim of correct rotary placement. |
| Confirmed workpiece-frame tool-tip XYZ and verified constant orientation for the whole supported operation | Fixed-orientation tool on the path, without a complete machine model. |
| Confirmed workpiece-frame tool-reference XYZ and final orientation at every sample | Rotary tool display in the same simple view. |
| Raw machine-axis positions | Requires axis chains, signs, offsets and relevant pivot positions before producing the above poses. |

A cutter centre, milling tip, ball centre, turning virtual tip and insert nose
centre are not interchangeable. Always requesting `center` is not proof of any
particular reference convention. Geometry-to-reference alignment must be tested.
Missing pose support is an explicit unavailable state, not permission to guess.

### 11.2 Sources and selected machine families

Official Haas sources located and read online:

- [UMC Series Operator's Manual Supplement - Introduction](https://www.haascnc.com/service/online-operator-s-manuals/umc-series-operator-s-manual-supplement/umc---introduction.html): identifies the series supplement and its relationship to the general Mill Operator's Manual.
- [UMC Operation, section 6.1](https://www.haascnc.com/service/online-operator-s-manuals/umc-series-operator-s-manual-supplement/umc---operation.html): explicitly documents separate B- and C-axis work offsets and workpiece orientation. It also distinguishes the B offset rule when DWO is used.
- [UMC G-Codes, section 8.1](https://www.haascnc.com/service/online-operator-s-manuals/umc-series-operator-s-manual-supplement/umc---g-codes.html): lists G234 TCPC separately from G254 DWO and G255 cancellation.
- [Haas UMC-1000 product specification](https://www.haascnc.com/machines/vertical-mills/universal-machine/models/umc-1000.html): identifies the model as supporting 3+2 and simultaneous five-axis machining. The web documentation is a series manual plus a model page, not a downloaded model-specific PDF or a calibrated geometry dataset.

Use the B/C workpiece-table layout as the reference for **MILL DEMO**. Separate
FANUC and Siemens execution profiles share that demo mechanical description.
Do not label either as an actual Haas controller, copy Haas G234/G254 semantics
into FANUC/Siemens handlers, or claim a calibrated UMC-1000 digital twin. Any
chosen demo signs, zeros and dimensions are explicit demo conventions.

STAR sources are the user-supplied operation manuals, read locally. References
below use printed section/page numbers because temporary attachment paths are
not portable. Missing figures and flattened tables in the extracted Markdown
must be checked against the original diagrams before adopting dimensions/signs.

| Profile to define | Family / paths | Verified mechanical facts and source |
| --- | --- | --- |
| MILL DEMO | Milling / 1 per controller profile | XYZ linear positioning with B/C workpiece rotation; use a B-parent/C-child demo table chain, not the earlier A/B illustration. Haas references above. |
| STAR SG-42 | Fixed-headstock turning / 2 | Main spindle rotates without a longitudinal headstock slide; one 10-station turret moves in X/Y/Z and serves front/back machining; subspindle translates in ZB. Six controlled axes including C1/C2. M03 resets the resolved C1/C2 axis to zero before spindle motion. Manual No.200K0E/1-2, applicable from serial 0084, sections 3-6 to 3-8, 4-1 and 4-9. |
| STAR SR-20R IV Type B | Sliding-headstock Swiss type / 2 | Main workpiece moves in Z1/C1; main tool post in X1/Y1; only the tilting three-spindle tool unit uses B1. Subspindle moves in X2/Z2/C2; back-tool selection also involves Y2. M03 resets the resolved C1/C2 axis to zero before spindle motion. Manual No.200T0E/1-7, applicable from serial 0921, sections 3-6 to 3-10, 4-1 and 4-12. |
| STAR SV-20R | Sliding-headstock Swiss type / 3 | Main spindle Z1/C1, gang post X1/Y1, back attachment X2/Z2 with subspindle rotation and Y2 back-tool selection; additional eight-station X3/Y3/Z3 turret can machine at either spindle. M03 resets the resolved C1/C2 axis to zero before spindle motion. Supplied edition 1-2, sections 3-6 to 3-11, CNC specifications 4-3-1 and tool functions 8-24 to 8-26. Do not import the SR model's B1 tilting-unit assumption. |

The SR manual's section 4-1 specifies diameter input for X1/Y1/X2/Y2; SG section
4-1 specifies diameter input for X but radial/linear input for Y/Z/ZB. Do not
replace these differences with a generic "all lathes use diameter X only" rule.
Convert executable coordinates in the engine exactly once; mesh sizes and final
plot positions are physical mm. Do not halve already-normalized plot coordinates.

### 11.3 Tool ranges: carrier identity is not tool geometry

Keep `tool_selection` as the controller's source of tool-call decoding. Match
simulation assignments against the existing resolved `segment.toolNumber`,
scoped by channel. Do not add a frontend T-code scanner or universally divide
raw T words by 100. Named tools and numeric tools retain their exact types.

Verified range candidates below describe ordinary NN00 tool calls; their mapping
to emitted physical IDs must be verified by engine fixtures before activation:

| Model | Candidate assignments | Exceptions that must remain explicit |
| --- | --- | --- |
| SR-20R IV B | PATH1: tool groups 1-5, 7-9, 11-12, 13-16 and B1 tools 17-19. PATH2: back unit 21-28. Sections 8-21 to 8-23. | T600 is an optional stopper. PATH2 can also call 13-19 and 31/32; not all PATH2 tools are on the back unit. T2000/T2900 are pickup/ejection positions, not cutters. T4100/T4200 are deep-hole tools. Cartridge subtool IDs such as 3111/3112 and 3221/3222/3223 require exact mappings. |
| SV-20R | PATH1: cut-off 1, tools 2-7 for unit 1B101 or 2-6 for 1B102, and cross tools 11-15. PATH2: 21-28. PATH3: turret 31-38. Sections 8-24 to 8-26. | T1000 is an optional stopper. T2000/T2900 are pickup/ejection positions. Multi-tool unit ID suffixes distinguish actual tools; retain them rather than treating every suffix as wear offset. Turret target spindle cannot be inferred from PATH3 alone. |
| SG-42 | Turret stations 1-10, selectable from PATH1 in M171 mode or PATH2 in M172 mode. Sections 8-15 to 8-18. | One physical turret, not one per channel. T2000 is a PATH2 pickup/ejection command. IDs such as T351/T352 distinguish tools on the same station. Channel ownership/machining target must follow the supported executed mode. |

Rules for the proposed matcher:

- Numeric ranges are inclusive, use safe integer bounds, and match numbers only.
- Exact-ID lists support sparse numeric subtools and Siemens names. No numeric-string coercion.
- Reject overlapping range/list assignments within the same channel; no first-match priority or implicit overrides.
- A range chooses a carrier and target policy, not equal station positions or equal cutter orientation.
- Per-tool mounting orientation remains in the program's complete tool definition. Unit/station-specific reference corrections must be explicit when required.
- Missing mappings, tooling variants or shared-axis mode information produce a diagnostic. A declared range does not prove the engine can execute every member.
- Retain fixed target mappings where true. For shared turret/front-back use, resolve the target during execution or reject the unsupported mode; do not guess a spindle.

### 11.4 Proposed machine JSON

Retain the existing top-level machine map, executable `name`, `control_type`,
`machine_type`, `channels`, `tool_selection` and other parser/control settings.
Add one versioned `simulation` object per profile. Its inner lowerCamelCase JSON
is transported unchanged through the API after validation, avoiding a second
renamed schema. Do not repurpose the existing overall `tool_range` field.

Contract status: configuration validation, fingerprints and request negotiation
are implemented in the sibling engine and both API adapters. B/C MILL profiles
and configured STAR target profiles advertise the contract only where their
producer and target mapping are installed. Pose output is retained in immutable
runs; full machine simulation remains future work.
The calculation responsibilities and numerical checks are specified separately
in [Backend tool-pose calculations](backend-tool-pose-calculations.md).

This is a **partial illustrative config**, not a ready-to-run machine. Parser,
lexer and supported handler settings are deliberately omitted. The shown rotary
directions/zeros are demo definitions, not measured Haas parameters. Positions
use mm, angles degrees and quaternions XYZW under schema version 1.

```json
{
	"FANUC_MILL_DEMO": {
		"name": "FANUC_MILL_DEMO",
		"control_type": "FANUC",
		"machine_type": "MILL",
		"channels": 1,
		"axes": ["X", "Y", "Z", "B", "C"],
		"simulation": {
			"schemaVersion": 1,
			"revision": 1,
			"modelId": "MILL_DEMO",
			"displayName": "MILL DEMO",
			"fidelity": "demo",
			"poseContract": "workpiece-tool-reference-v1",
			"carriers": [
				{"id": "millingSpindle", "role": "tool", "referenceOrientationDegrees": [0, 0, 0], "rotationChain": []},
				{
					"id": "tableBC",
					"role": "workpiece",
					"referenceOrientationDegrees": [0, 0, 0],
					"rotationChain": [
						{"axisId": "B", "axis": [0, 1, 0], "sign": 1, "zeroDegrees": 0},
						{"axisId": "C", "axis": [0, 0, 1], "sign": 1, "zeroDegrees": 0}
					]
				}
			],
			"toolMounts": [
				{
					"channelId": "1",
					"tools": {"kind": "numericRange", "from": 1, "to": 99},
					"carrierId": "millingSpindle",
					"target": {"mode": "fixed", "workpieceCarrierId": "tableBC"}
				}
			]
		}
	}
}
```

`SIEMENS_MILL_DEMO` uses the same simulation description with its own explicit
Siemens execution settings. The range 1-99 is a demo choice, not a Haas tool
capacity. Named tools use explicit `identifiers` selectors. `modelId` identifies
the shared design; it must not trigger inferred axes, hidden defaults or unknown
controller behavior. Keep one canonical validated demo description when building
the two profiles; do not duplicate kinematics code per controller.

`rotationChain` is outermost-to-innermost; each axis vector is expressed in its
parent frame. It describes rotation only, not a complete axis-position model.
`referenceOrientationDegrees` is required on each configured carrier: it maps
that carrier's zero-joint basis into the machine basis, using Rz * Ry * Rx.
Compose this constant rotation before the outermost joint rotation. An explicit
zero tuple is valid for MILL DEMO; omitted calibration is not an identity default.
The actual workpiece setup basis relative to its carrier is resolved separately
by the engine. Do not confuse carrier reference orientation with workpiece setup.
An empty tool chain means no commanded head rotation, not no XYZ translation.
Do not feed raw machine XYZ into this reduced model and pretend pivots are zero.
For STAR, use physical IDs such as B1/C1/C2 and explicit execution-side channel
bindings; C in another path must not silently reuse C1. Add chains only when their
directions and reference offsets have been checked for the specific assembly.

Example isolated SR back-unit assignment, after verifying physical IDs 21-28:

```json
{
	"channelId": "2",
	"tools": {"kind": "numericRange", "from": 21, "to": 28},
	"carrierId": "backToolUnit",
	"target": {"mode": "fixed", "workpieceCarrierId": "subSpindle"}
}
```

For a shared turret, use an explicitly runtime-resolved target instead:

```json
{
	"mode": "execution",
	"allowedWorkpieceCarrierIds": ["mainSpindle", "subSpindle"]
}
```

Exact sparse selections have the form `{"kind":"identifiers","values":[3111,3112]}`.
Carriers, channel IDs and target references must all resolve within the profile.
These declarations specify what is allowed; engine output specifies what happened.
Do not mark uncalibrated STAR profiles as demo data or fill absent real-machine
mount dimensions with zeros. Their source-backed layout can be recorded while
unverified pose capabilities remain disabled.

#### Profile discovery and validation

`GET /api/machines` and CGI `action: "list_machines"` must describe the same
loaded profiles. Each machine entry exposes `machineName`, `controlType`,
`machineType`, `axes`, `availableChannels`, `profileRevision`,
`supportedPoseContracts` and the validated `simulation` object when configured.
Existing tool-selection, syntax and extension fields remain unchanged.

- `simulation.revision` is a positive integer incremented for simulation-config changes. `profileRevision` is an opaque backend-produced fingerprint of all effective execution/simulation settings, including referenced model data; it also detects changes outside `simulation`.
- `supportedPoseContracts` is an explicit array. It is enabled only when the
	loaded configuration and installed engine jointly implement the contract.
	Individual NC modes, unresolved targets and unsupported references may still
	be rejected at execution.
- `axes` lists actual physical axis IDs; `availableChannels` comes from configured `channels`, not file-extension entries or frontend defaults. STAR execution handlers own the binding of a channel's address C to a physical C1/C2 axis.
- Carrier IDs are unique. Tool carrier and target references must have the correct role. Channels must exist; exact IDs and inclusive integer ranges must not overlap within a channel. Unknown fields/versions in this new object are errors, not silently discarded settings.
- Axis vectors must be finite unit vectors; `sign` is exactly -1 or 1; `zeroDegrees` is finite. The joint angle used by the rotation chain is `sign * (executedAxisDegrees - zeroDegrees)`. Execution supplies a physical joint coordinate, not an unconverted work-offset display value.
- Carrier reference orientations are finite degree triples; compose them once with the joint chain and the known setup basis, not again in the renderer.
- All rotary samples needed by a chain must be present in execution state. No absent-axis-as-zero behavior. The config loader must retain and validate the object rather than ignore it.
- Pose-mode BYOC is outside the initial version-one implementation. Reject `customMachineConfig` on a pose request rather than ignoring it or falling back to the named profile. Path-only BYOC behavior is a separate API concern.

### 11.5 Why A/X, B/Y, C/Z is not enough

Conventionally A rotates about X, B about Y and C about Z. X/Y/Z are translations,
not objects rotated automatically by their paired letters. We also need to know
which body rotates and which axis carries the next one.

In the simplified MILL DEMO, B carries C on the workpiece side. With right-handed
column-vector rotations and the explicitly defined demo signs:

$$
R_{workpiece}=R_y(B)R_z(C),\qquad
R_{tool\ relative\ to\ workpiece}=R_{workpiece}^{-1}R_{tool}.
$$

Thus a table rotation appears inverted in the stationary-workpiece view. An
SR B1 tool-head rotation belongs on the tool side and does not rotate every tool.
Multiplying a generic Euler(A,B,C) onto every tool would get these cases wrong.

For raw positions, the general conversion is
`T_workpiece_tool = inverse(T_machine_workpiece) * T_machine_tool`.
Pivot translations matter in that conversion. If the engine already returns
workpiece-frame tool-reference XYZ, **do not transform those positions again**.
Rotation about a pivot can be omitted in the renderer, not in an upstream
conversion that actually needs the pivot.

### 11.6 The render contract: resolved poses, not raw ABC

This is the API contract **`workpiece-tool-reference-v1`**, shared by CGI
and FastAPI. Its validation/negotiation and successful pose response are
implemented for the bounded `MILL_DEMO` profiles only. It extends the
existing object request and `canal` response, not a second execution endpoint.

**One explicit Plot action sends one POST for every selected channel together.**
Machine discovery happens on load/refresh, not on cursor movement. The one Plot
response contains all paths and poses. No per-tool, per-point, selection or
playback request is required. Later edits require another explicit Plot action.

#### Pose request

`poseContract` is optional only to distinguish an explicitly path-only request
from a pose request. When supplied, it must be recognized, supported by every
requested profile, and paired with `toolPathMode: "center"`. Never silently
downgrade it. Pose requests accept the object shape only, with unique channel IDs.

```json
{
	"toolPathMode": "center",
	"poseContract": "workpiece-tool-reference-v1",
	"machinedata": [
		{
			"program": "T1\nG17 G90 G1 X10 Y0 Z10 F100",
			"machineName": "FANUC_MILL_DEMO",
			"canalNr": "1",
			"toolValues": [{"toolNumber": 1, "rValue": 4}],
			"toolOffsets": [],
			"customVariables": [],
			"simulation": {
				"profileRevision": "demo-profile-1",
				"tools": [
					{
						"toolNumber": 1,
						"reference": "millingTip",
						"mountingOrientationDegrees": [0, 0, 0]
					}
				]
			}
		}
	]
}
```

The program and revision token are illustrative; this is not a production
machining program. A multi-channel Plot adds entries to the same `machinedata`.
Each entry names its exact profile and discovery fingerprint. The backend rejects
a stale fingerprint before executing any channel and echoes the accepted one.
It uses one detached effective config snapshot throughout execution.

`simulation.tools` contains minimal, detached inputs from the program snapshot:

| Field | Version-one meaning |
| --- | --- |
| `toolNumber` | Existing exact physical numeric/string ID, independent of offset registers; duplicate IDs within the channel are rejected. No alternative active-tool state. |
| `reference` | `millingTip` (axial cutting extremity on the cutter centreline) or `turningVirtualTip` (the controller-defined theoretical turning tip, not the nose-radius centre). The assembly origin must match this reference. The vocabulary does not imply that both calculations are implemented. |
| `mountingOrientationDegrees` | Explicit finite XYZ degree tuple mapping the assembly to the assigned carrier's local reference frame. Fixed extrinsic X, then Y, then Z: Rz * Ry * Rx. An explicit zero tuple is valid; absent/unknown mounting is not silently treated as zero. |

For this pose contract, preserve section 3's canonical-machine meaning of program
`orientation`: it defines the assembly's mounting orientation at the carrier's
reference joint position, not a commanded orientation at each sample. Project it
once at request capture using `R_mount = inverse(R_carrier_reference) * R_program`.
Encode that known rotation in the defined degree convention. Do not silently
reinterpret canonical-machine angles as carrier-local angles. Missing carrier
reference calibration makes this projection unavailable. Schema-defined identity
program orientation is a known value, unlike missing machine calibration.
Geometry-part position/rotation remains assembly-local.

No holder/cutter meshes, library IDs, material vertices or complete tool definitions
are sent. Missing `simulation.tools` entries are not generated from the library.
They can yield `toolMountUnavailable` only if the path coordinates are independently
known valid. `lengthValue`, Q/R and edge/register tables remain separate execution
inputs, never inferred from stick-out, a mesh's length or its diameter. The caller
does not choose the active tool, target spindle, executed ABC values or final pose.

Explicit `rValue: 0` is valid in tool defaults or a selected positive-numbered
offset register. It means zero radius displacement, not missing data, cancelled
G41/G42, or permission to use another radius. Negative/missing radii still fail
compensation activation. Register selector zero cancels offset data; it is not
the same as a record containing radius zero.

For the initial scope, the engine/profile must establish the initial workpiece
frame from its known setup. Client-assigned names alone do not establish a physical
transform. Additional arbitrary setup/fixture transforms are deferred; programs
requiring unresolved setup information cannot return a successful pose-contract run.

#### Pose response

Return this complete envelope, retaining existing variable/error/timing fields
where applicable. `demo-profile-1` illustrates an opaque revision, not a literal
fingerprint all demo profiles should share.

```json
{
	"success": true,
	"poseContract": "workpiece-tool-reference-v1",
	"executionOrigin": "engine",
	"canal": {
		"1": {
			"machineName": "FANUC_MILL_DEMO",
			"profileRevision": "demo-profile-1",
			"workpieceFrames": [
				{
					"frameId": "main-setup-1",
					"workpieceId": "part-main",
					"workpieceCarrierId": "tableBC",
					"basis": "initialWorkpiece"
				}
			],
			"segments": [
				{
					"lineNumber": 2,
					"executionStep": 1,
					"toolNumber": 1,
					"geometry": "LINEAR",
					"traversal": "FEED",
					"sourceCode": "G01",
					"frameId": "main-setup-1",
					"toolReference": "millingTip",
					"points": [
						{"x": 0, "y": 0, "z": 10, "toolPose": {"status": "resolved", "orientation": [0, 0, 0, 1]}},
						{"x": 10, "y": 0, "z": 10, "toolPose": {"status": "resolved", "orientation": [0, 0, 0, 1]}}
					]
				}
			]
		}
	}
}
```

This replaces the earlier illustrative segment-level workpiece fields: resolve
`frameId` through the returned per-channel `workpieceFrames` table. Frame lookup
is scoped by `(client runId, channelId, frameId)`; identical strings from different
channels do not authorize overlaying their geometry.

Required semantics:

- A successful pose response has exactly the requested channels, exact machine/revision echoes, and the requested contract. XYZ and pose values are captured for the same sample of the same executed movement.
- XYZ are finite physical mm in the identified right-handed workpiece frame, whose initial basis is fixed to that workpiece for the supported run. Subsequent work-offset/coordinate changes are converted to this frame, not applied to the stored material. Never return mixed frame coordinates.
- `toolReference` states what XYZ locates. It must match the assembly origin and the requested per-tool reference when a tool is known. The initial version has no selectable ball-centre or nose-centre output and no automatic client-side reference correction.
- `toolPose` is required at every point: either `{"status":"resolved","orientation":[x,y,z,w]}` or `{"status":"unavailable","reason":"orientationUnavailable"}`. Allowed reasons are `activeToolUnavailable`, `toolMountUnavailable`, `orientationUnavailable`, `toolReferenceUnsupported` and `kinematicsUnsupported`; orientation is absent in the unavailable variant.
- Resolved quaternion XYZW is finite and unit length (absolute norm error at most 1e-6). It maps assembly-local geometry into the selected workpiece frame and includes the fixed mounting rotation exactly once. The renderer applies local part transforms but does not reapply program assembly orientation, Q, ABC, radius or length compensation.
- Unavailable pose is allowed only when XYZ, reference and target/frame are already trustworthy independently of the unavailable orientation/tool mapping. It is not an escape hatch for guessed XYZ. If missing tool radius, nose correction, TCP data, target or setup makes the coordinates uncertain, fail the pose request instead.
- Keep numeric/string tool IDs, zero and the existing unavailable sentinels exact; never synthesize tool 1. Reject invalid identifiers, negative/noninteger steps, malformed point data and inconsistent references. No generic tool-zero activation/unload inference in the frontend.
- At least two ordered points per movement segment. Include rotary-only movements even if XYZ is unchanged. The engine must subdivide rotary motion before quaternion encoding; equal endpoint quaternions cannot encode multi-turn motion.
- Split segments at tool, target/frame, reference or motion-semantics changes. Shared cycle execution steps and original response/pair ordinals survive frontend tessellation. An explicitly unclassified continuous path can retain null semantic fields; do not classify it from duration or drop it merely to fit a pose feature.
- No arbitrary XYZ selection request. The existing resolver chooses the endpoint of the last subsegment in the selected occurrence. Client-local `runId` remains owned by ExecutedProgramService; no extra backend run store is required.

#### Failures and explicit demos

```json
{
	"success": false,
	"canal": {},
	"message": ["Pose output requires a supported TCP model"],
	"errors": [
		{"code": "POSE_CALCULATION_UNSUPPORTED", "channelId": "1", "lineNumber": 12, "executionStep": 5}
	]
}
```

Contract/config errors use codes `POSE_CONTRACT_UNSUPPORTED`,
`PROFILE_REVISION_MISMATCH`, `SIMULATION_INPUT_INVALID`,
`POSE_CALCULATION_UNSUPPORTED`, `POSE_COORDINATES_UNRESOLVED` or
`ENGINE_EXECUTION_FAILED`. Include channel/source context where available, not
fabricated line numbers. FastAPI may additionally use HTTP 4xx/5xx; both adapters
must retain this failure envelope. Initial pose mode is all-or-nothing on fatal
channel errors; do not attach partial new poses to an old displayed run. A valid
no-motion execution is successful with an empty segment list.

`executionOrigin: "engine"` describes normal execution, including an explicitly
selected demo machine profile. `"demoFixture"` is reserved for a separately
selected deterministic fixture action (future `action: "plot_demo"` with a
registered `fixtureId`), never an automatic response to engine failure. A fixture
must own its sample source/tool snapshot and must not masquerade as execution of
the user's submitted NC text. Automatic mock fallback is no longer invoked by
CGI or [main_import.py](../backend/main_import.py); engine failures and recorded
NC errors now return unsuccessful responses.

The renderer shows one workpiece frame at a time initially. Do not merge spindle
frames or front/back setups without explicit transforms, or duplicate a shared
turret by channel. Workpiece transfer and a common two/three-channel timeline
are deferred; equal local `executionStep` values do not establish simultaneity.
The contract does not authorize inventing a C angle from spindle RPM.

Backend calculation details, ownership, pipeline ordering, current adapter gaps
and required numerical fixtures are in
[Backend tool-pose calculations](backend-tool-pose-calculations.md).

### 11.7 Work performed once versus on every selection

| Boundary | Work |
| --- | --- |
| Profile load | Validate versions, channels, carrier references, rotation chains and tool selector overlaps; build exact/range lookup tables. |
| Explicit Plot request | Freeze program tools, mounting inputs, selected profile/revision and setup with the existing run input. No library dependency. |
| Engine/adapter execution | Resolve active tool, target, units, reference point, compensation and rotary poses using actual executed state. |
| Completed-run installation | Validate and retain poses per ordered subsegment; build source/occurrence index once. Build supported meshes once per used immutable tool definition, or lazily on first use. |
| Cursor/occurrence change | Indexed segment lookup, select cached mesh, copy endpoint XYZ and quaternion, draw. No parsing, network calls, new execution, geometry generation or search through all tools. |
| Later playback between samples | Lerp position and slerp orientation for already sampled moves; sampling/timing limits stay explicit. No new forward/inverse kinematics. |
| Clear/replacement/disconnect | Release run-owned geometry/materials, selection and subscriptions. |

Use Three.js quaternion/matrix APIs for transforms, not a new handwritten math
engine. A transform per selected object is cheap; rebuilding meshes, reparsing NC
code and solving kinematics per frame are the costs to avoid. Do not add a second
global run store or event-driven active-tool state machine. The existing
`getRunTool()` remains authoritative for a plotted run's geometry.

### 11.8 Scoped delivery sequence

1. **Contracts and profile transport.** Add typed/validated simulation configuration, range/exact selectors and the pose union. Teach the ncplot7py config loader to preserve the new object and both API adapters to advertise it explicitly. Replace MachineService's hardcoded XYZ/three-channel profile conversion with authoritative axes/channel information; do not infer capabilities from names. Add separately named MILL DEMO FANUC/Siemens profiles only when their handlers are defined. Real STAR profiles remain distinct by model and tooling variant.
2. **Geometry independent of kinematics.** Build drill, flat/corner-radius end mill and ball mill meshes, plus box/cylinder/cone/profile holders and the supported C/D/V/W/T/S/R/E/H/O/P/L/A/B/K insert previews from the validated schema. Use the documented Z-up assembly/tip convention. The current factory has focused local-origin tests, but a successful preview is not proof of correct turning nose-centre, virtual-tip or machine placement. Grooving/threading/custom forms remain explicitly unsupported until implemented.
3. **Explicit demo fixture.** A selected MILL DEMO fixture returns deterministic XYZ plus B/C-derived workpiece-frame poses for at least two tools. Mark `demoFixture` visibly and do not silently substitute it for user NC execution. Test signs and multiplication order with 90-degree rotations before general arbitrary-angle cases. Actual FANUC/Siemens execution support is a separate engine gate, not established by the fixture.
4. **Simple plot integration.** Extend BackendPlotSegment/PlotPoint mapping in ExecutedProgramService so poses survive tessellation and run snapshots. NCToolpathPlot moves one cached tool root from the current occurrence selection. Give axes, path, tool, material and highlight explicit scene roles; tool motion must not trigger Fit View. Optional material UI is independent and does not block tool rendering.
5. **STAR fixed-target operations.** Add SG-42 fixed-headstock and SR/SV Swiss-type layout mappings from the manuals and exact engine tool-ID fixtures. Validate actual mounting/reference and diameter conventions before enabling supported operations. Support only proven targets/modes first; unavailable combinations remain visibly unavailable.
6. **Shared assemblies and playback later.** SG M171/M172 ownership, SV turret target switches, SR shared front/back tool units, part transfer and synchronized two/three-channel time belong in engine trace support. Full machine frames/pivots are required only if converting raw machine state or animating the whole machine, not merely drawing already-resolved tool poses.

Focused acceptance checks:

- JSON rejects invalid versions, overlapping ranges (including endpoints), nonexistent channels/carriers and named-number coercion; unknown profiles do not inherit demo behavior.
- Tools 0 and named tools retain exact identity; STAR subtools remain distinct; standby/ejection codes are not rendered as cutters.
- Known XYZ reference/units fixtures, table-versus-head rotations, B-parent/C-child order, reverse C1/C2 conventions where verified, and no double application of orientation/compensation/diameter conversion.
- Repeated XYZ with different tools/rotations, sampled arcs, rotary-only moves and multi-turn samples survive the entire backend-to-run mapping.
- Valid shape bounds, reference tips, explicit holder transforms and geometry reuse/disposal. No accurate turning pose until virtual-tip/nose-centre tests pass.
- Selection causes zero backend calls and zero mesh rebuilds after first use. Stale/unknown selections hide the tool without erasing valid paths.
- Separate workpiece frames and shared physical carriers are not duplicated by channel count. No simultaneous-playback claim without shared time data.
- Browser checks at desktop/mobile sizes verify visible meshes, rotation, tool switching, independent axes visibility and clear/disconnect behavior. No material-removal or collision-accuracy claim follows from these checks.