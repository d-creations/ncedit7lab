# Tool management and portable simulation metadata

Status: proposed design, not implemented. Updated: 2026-09-11.

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

Store only the exact backend `machineName` in the setup block, not a display label, repeated units or control type. The surrounding metadata marker carries the schema version. Resolve control/comment capabilities through that machine profile; metadata geometry is always mm by schema convention.

On open:

1. Read recognized metadata comments without executing their contents.
2. Resolve the stored name through MachineService.
3. If supported and unambiguous, restore the selection and reparse using that profile.
4. If unknown, preserve the name and show a clear unresolved-machine state; do not silently run with a default machine.
5. If channels disagree, show a conflict because the current application uses a global machine selection. Do not let the last parsed channel win.

The machine name is enough to select an installed profile. It is **not** a complete machine model: exact future reproduction also needs profile/engine versions and, eventually, kinematics and setup data. A profile revision/hash can later detect drift without copying the whole machine configuration into every NC file.

Place the header near the top at a dialect-approved position, respecting mandatory `%`, program-number or Siemens file headers. Do not blindly prepend ahead of required syntax. For separate channel files, each must carry enough setup metadata to reopen independently. Verify multi-channel split/join round trips before choosing placement in combined containers.

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
- Recognize selections using machine-aware parsing, not a global T-number replacement: account for named tools, combined tool/offset codes and preselection versus activation. Do not insert into text that merely mentions a tool inside another comment.
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
| `ProgramMetadataEditService` | Locate safe insertion points and generate minimal undoable edits. |
| `ToolExecutionAdapter` | Map program assignments into existing Q/R request values with unit handling. |
| `ToolGeometryFactory` | Future deterministic Three.js meshes from validated parametric geometry. |

Register services centrally through existing ServiceRegistry/ServiceTokens. Use Web Components, EventBus, TypeScript and existing browser/Three.js APIs; no new frontend framework. Keep the backend stateless for personal libraries.

The extension source is not present in the explored workspace. Host filesystem persistence and contributed views require coordinated changes in that extension project; frontend messages alone cannot implement these capabilities.

## 8. Tool manager UI

Reuse one Web Component in a web sidebar and a VS Code WebviewView, similar to Templates. Users can move the contributed view into VS Code's secondary/right sidebar.

- Tabs: **Library** / **Program Tools**.
- Search/filter by tool type and machine compatibility.
- List with original schematic icons and name/dimensions; avoid copying manufacturer product images without permission.
- Editing sections: General, Geometry, Holder/Mounting, Compensation (Q/R), Preview.
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
6. **Future simulation:** parametric tool/holder meshes and execution-aware tool activation; material removal/collision checking is a separate project, not achieved simply by storing geometry.

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