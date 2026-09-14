# Backend tool-pose calculations

Status: partially implemented, 2026-09-14. The sibling engine and both adapters
now implement `workpiece-tool-reference-v1` for the bounded `MILL_DEMO` model.
`FANUC_MILL_DEMO` and `SIEMENS_MILL_DEMO` advertise the contract; STAR and all
other profiles deliberately advertise no pose contract. A pose request validates
the exact profile revision, centre mode, channel/tool IDs, `millingTip` reference
and finite mounting orientation before execution. The engine captures motion
context, uses explicit B/C initial axes, emits one workpiece-frame pose per output
point, interpolates B/C along a primitive, and serializes the same result through
FastAPI and CGI. The renderer does not calculate kinematics.

The remaining sections are the wider implementation specification. Features not
needed by the verified demo remain open: real-machine calibration and targets,
turning references, length/TCP semantics, non-demo frame changes, full-turn
sampling and bounded adaptive subdivision. They must fail explicitly rather than
being inferred from the current demo implementation.

## 1. Boundary and existing behavior

One Plot action executes one POST containing all selected `machinedata` channels.
Compute coordinates and orientations together during that execution, serialize
them once, and retain the result in the frontend's immutable run. There is no
pose endpoint, per-tool request, cursor-triggered execution or backend run store.

Evidence from the supplied ncplot7py CGI, compensation plan and handlers:

| Existing behavior | Consequence for this work |
| --- | --- |
| Tool handlers already capture the active tool ID; generated moves expose toolNumber/executionStep. | Reuse them, including exact STAR subtool IDs and Siemens names. Do not implement a second active-tool scanner. |
| The shared projector implements FANUC mill and Siemens ISO radius compensation on sampled polylines. | Keep the existing radius kernel; do not compensate again while computing poses. Analytic corner/lead-in accuracy is not implied. |
| Turning Q/nose correction and dynamic TCP are still incomplete in the supplied plan. | Do not advertise those operations as resolved centre/reference output. |
| The supplied Siemens ISO length handler uses H as a literal Z offset. | This is not H-register lookup or general tool-axis compensation. Detect/diagnose this limitation on the new contract until replaced. |
| CGI and FastAPI now set CNCState.tool_path_mode from the request. | Real-engine tests cover centre output, including explicit R=0 and nonzero radii. |
| Both adapters now reject unavailable/failed execution and recorded NC errors instead of invoking mock fallback. | Empty successful engine output is legitimate. Failed runs no longer masquerade as successful partial/mock plots. |
| Supplied CGI_API.md contains older preprocessing/control descriptions alongside newer segment documentation. | Verify changes against executable code/tests; do not reintroduce obsolete whitespace removal or parenthesis rejection based on that prose. |

Engine files are in the sibling ncplot7py repository supplied by the user;
FastAPI integration is [backend/main_import.py](../backend/main_import.py).
Implement shared calculations in the engine package. HTTP/CGI wrappers validate,
invoke and serialize; they must not contain separate rotation/compensation maths.

## 2. Validate and snapshot before executing

1. Validate the complete request, contract, centre mode, unique channel IDs,
   exact tool IDs, reference enums, finite mounting tuples and payload bounds.
2. Resolve each named config and compare the request's profileRevision against
   the loaded effective profile. Reject the whole request on a mismatch before
   executing channels. No default profile or pose-mode BYOC fallback.
3. Freeze/copy effective config, compensation tables and mounting inputs. Build
   carrier and tool-range/exact-ID lookup once; reject inclusive overlaps.
4. Establish the supported initial workpiece frame and its spindle/table target
   from known setup state. A name is not a transform; missing required setup is
   POSE_COORDINATES_UNRESOLVED, not an assumed zero origin.

Precompute constant mounting rotation matrices/quaternions once per supplied
channel/tool, not once per movement. Validate model capabilities once, but also
check actual commands: supported fixed milling does not imply supported TCP.

## 3. Capture movement state at the output boundary

Use the common motion-batch/output boundary of BaseStatefulCanal described in
the supplied compensation plan. It must see normal moves and early-returned
cycle primitives, not just calls reaching MotionHandler.

Retain the following beside each primitive/sample until final serialization:

- Source line, channel, execution step, geometry/traversal and source code.
- Exact active tool and selected offset/edge values in effect for that move.
- Start/end physical rotary state, including the executed angular route and
  intermediate samples. Start state cannot be reconstructed from final state.
- Workpiece frame/target, active units, work offsets, coordinate transforms,
  compensation modes and relevant shared-axis/ownership state.

Buffered radius joins must retain this context with the buffered primitive.
Do not apply the next block's tool, offsets or axis angles to an earlier move
when flushing on G40, program end, tool change or error. Split/flush at context
boundaries according to the existing command semantics.

## 4. Normalized reference position

The output XYZ and the mesh origin must represent the same reference point.
Version one uses millingTip or turningVirtualTip, never an implicit ball/nose
centre. The metadata mesh must be aligned to this origin separately.

### Units and input coordinates

Convert inch motion to mm where the engine supports it, including applicable
offset values. Normalize diameter-programmed axes to physical radius distances
once before geometric operations. Consult each machine's actual policy: SG-42
and the Swiss-type models do not share all X/Y input conventions.

Do not halve already-normalized points at serialization and do not scale tool
metadata dimensions, which are already mm. Preserve controller rotary units and
zero/sign conventions independently of linear unit conversion.

Resolve incremental/absolute positions and program frames through the existing
handlers. Convert later G54/G55, G92, TRANS/ROT or equivalent changes to the same
initial workpiece frame. Never move the saved workpiece just because a later
program coordinate system changes. Unsupported frame modes must be diagnosed.

### Radius and turning nose compensation

Reuse the shared radius projector in its documented working plane/frame. Preserve
its look-ahead/joins, duration and source identity. Do not add cutter radius to
XYZ in the pose stage or infer radius from a mesh.

Turning additionally requires a controller-specific mapping of Q and nose radius
to the theoretical tip/nose-centre relationship and compensated side. Keep that
mapping separate from physical tool mounting orientation. Until that correction
is implemented and tested, reject pose-contract output that depends on it.

Changing an offset alone does not necessarily change the physical tool. Explicit
offset records own their compensation data; never merge a missing value with a
different register or silently fall back to geometry-derived defaults.

Explicit `rValue: 0` is implemented as a valid compensation value. G41/G42 remain
selected, but the radius projector returns an unshifted path. Missing radius is
not converted to zero; negative radius is rejected at activation. A zero radius
in a selected positive offset register takes precedence over any nonzero tool
default. This is different from D0/T00 cancelling the selected offset data.

Verification note: existing nonzero entry/join tests currently have five failures
(two tests plus three subtests), reproduced with the pre-update radius handler.
The supplied engine also converts Siemens quoted numeric tool names such as
`T="1"` to numeric IDs during execution; this is a separate existing parsing
issue, not permission for API/config code to coerce identifiers. Neither issue
is fixed by this API/R0 increment.

### Length compensation and TCP

H is a register selector under the supported ISO convention, not a literal
length. Implement proper table selection and controller semantics before
claiming resolved G43/G44 poses; keep the existing simplified handler out of the
verified path. Tool length is not holder stick-out or a generated mesh bound.

Tool-axis length vectors belong in the execution/kinematics calculation with the
correct reference direction. Do not blindly add length to already tool-tip-based
XYZ. G49 cancels the relevant length compensation, not unrelated work offsets.

G43.4/G43.5, Siemens TRAORI or equivalent modes need a supported kinematic model
and their own verified semantics. A JSON rotation chain is not a TCP algorithm.
If the requested reference position depends on unsupported length/TCP behavior,
fail the pose request rather than return a plausible-looking uncompensated path.

## 5. Workpiece-relative orientation

Use right-handed column-vector transforms. For physical rotary joint value a,
the configured angle in degrees is `sign * (a - zeroDegrees)`. Use the actual
executed joint state after controller offset/mode resolution.

Each rotation chain is outermost-to-innermost with axis vectors expressed in the
parent basis. Build the constant rotation from the required carrier
referenceOrientationDegrees and multiply it by the ordered joint chain. For the
workpiece, also include the engine-resolved setup basis relative to that carrier.
Missing real-machine basis calibration or setup is not identity by default.

The request supplies assembly-to-carrier mounting rotation:

$$
R_{mount} = R_z(r_z) R_y(r_y) R_x(r_x).
$$

The frontend has already projected the saved canonical reference orientation
into this carrier-local mounting frame at request capture. Do not apply the
program orientation again or repeat that basis conversion in the engine.

Let R_MT map the tool carrier into the common machine basis and R_MW map the
workpiece frame into that basis. Then the final assembly-to-workpiece rotation is:

$$
R_{WA} = R_{MW}^{-1} R_{MT} R_{mount}.
$$

For MILL DEMO at explicitly identity reference bases, the tool head is fixed
and B carries C on the workpiece side:

$$
R_{MW} = R_y(B) R_z(C),\qquad
R_{WA} = R_z(-C) R_y(-B) R_{mount}.
$$

A table rotation therefore appears inverted in the stationary-workpiece view.
For SR tools actually mounted on the B1 unit, B1 contributes on the tool side;
it must not rotate the gang tools or the back-tool unit. For ordinary spindle-RPM
turning, do not manufacture a C position from RPM. A pose can omit irrelevant
spin only under a separately documented rotation-invariant display convention;
the resolved rigid-pose contract cannot claim an unknown angular phase.

Convert the composed rotation to quaternion XYZW. Normalize floating-point drift
at the producer after validating the inputs; reject degenerate/nonfinite values.
Output norm tolerance is 1e-6. Across a continuous sample sequence, choose the
equivalent quaternion sign with nonnegative dot product against the prior sample
to avoid representational sign flips. This does not recover missing full turns.

Use an established matrix/quaternion implementation already available to the
backend, or a deliberately chosen tested math dependency. Three.js remains a
frontend concern. Do not implement separate maths in each controller handler.

## 6. When pivot positions are needed

**Already normalized workpiece tool-reference XYZ:** retain those coordinates;
only calculate the corresponding orientation. No pivot translation is needed
in the renderer and no second rotation of the path is allowed.

**Raw machine/carrier positions:** calculate the complete transformations:

$$
T_{WA} = T_{MW}^{-1} T_{MT} T_{mount}.
$$

Here T_mount includes the actual carrier-to-assembly reference translation as
well as mounting rotation. The rotation-only request/config cannot supply this
translation; it must come from verified machine/tool setup, or conversion is
unsupported. A rotation around pivot p has homogeneous transform:

$$
T(p) R T(-p).
$$

Do not use zero pivots for a real machine. Demo zeros are acceptable only as an
explicit fixture model, not as inferred geometry. Mark internal coordinates by
their frame/reference and which stages have been applied, so only one conversion
path is used for each primitive. This prevents double compensation and rotation.

## 7. Sampling and shared transform pipeline

Extend the existing output projector instead of recomputing interpolated motion
in the adapter. Its exact order must respect each primitive's current coordinate
space. In particular, cutter compensation must operate in its intended frame,
not blindly on points already transformed for display.

```text
Existing controller interpretation and programmed motion/cycle generation
  -> capture immutable movement context and executed rotary trajectory
  -> existing normalized-coordinate and compensation stages
  -> supported reference/kinematic conversion and rotary pose sampling
  -> one final workpiece-frame position + assembly orientation per sample
  -> shared validation/serialization to CGI or FastAPI
```

Audit existing _transform_points_for_plot calls before adding this stage. Move or
compose the existing transformation only with regression fixtures proving that
it is applied once. Do not append a second generic ABC transform after it.

Requirements for sampling:

- Respect the configured directed/angular path and rollover policy. Do not infer
  the shortest route from the final quaternion or wrap a commanded full turn away.
- Couple XYZ and physical rotary samples at the same interpolation parameter.
  Use existing controller interpolation rules, not linear endpoint guessing for
  an unsupported simultaneous/TCP trajectory.
- Use bounded subdivision with position/chord tolerance and angular-step limits
  in the producer. An angular step must stay below 180 degrees; smaller configured
  limits control preview quality. Reject sample-limit exhaustion, not silent truncation.
- Include rotary-only moves with repeated XYZ. An entire 360-degree revolution
  requires intermediate poses even though start/end orientations are equivalent.
- If compensation inserts/splits points, retain or derive the corresponding
  pose/sample parameter under a verified policy. Until that policy exists,
  simultaneous rotary compensation is unsupported, not assigned the end angle.
- Preserve primitive duration and source metadata through subdivisions. Avoid
  copying a full duration onto every new subsegment. Timed playback requires
  per-sample timing and a shared channel timeline in a later contract.

## 8. STAR responsibilities

| Model | Required backend distinctions |
| --- | --- |
| SG-42 | Fixed main headstock, XYZ turret, ZB subspindle and C1/C2. M171/M172 selects the channel controlling one shared turret. Validate the actual machining target; do not create a turret per path. |
| SR-20R IV B | Sliding main headstock Z1/C1, gang X1/Y1, selected B1 tools, subspindle X2/Z2/C2 and back-unit Y2. Tool ranges do not imply every PATH2 tool belongs to the back unit. Respect documented B90 reference and C1/C2 sign differences after defining the common physical basis. |
| SV-20R | Gang and back units plus X3/Y3/Z3 turret. Resolve the turret's front/back target from executed supported modes; no inherited SR tilting-head behavior. |

Reuse existing tool-selection policy and active IDs. Treat subtool IDs exactly;
do not decode them a second time as wear offsets. Standby, pickup and ejection
commands are not cutting-tool definitions. Preserve no-motion execution state
without creating artificial path segments just to display a tool change.

First enable proven fixed-target operations. Unsupported shared-axis control,
target switches, part transfer, spindle coupling or setup changes must produce
clear diagnostics. Workpieces remain attached to their carrier during supported
operations, but carrier identity is not permanent part identity. No simultaneous
three-channel scene is justified by equal executionStep integers alone.

## 9. Serialization and failure policy

CGI build_segments_from_engine_output and the FastAPI import conversion must use
the same validated conversion contract. Do not fabricate missing y/z samples by
repeating the last coordinate or replace source lines with unrelated execution
list indices on the new pose path. Preserve one-to-one point/pose alignment.

Validate finite XYZ, frame/reference identity, unit quaternions, exact tools and
ordered occurrence metadata before declaring success. Register workpiece frames
once per channel/run and reference them by frameId. Unknown target/frame or
unresolved reference coordinates fail the entire initial pose-mode request.

Only an unavailable orientation/mount with independently valid path coordinates
may produce the per-point unavailable union from the contract. Missing rendering
geometry is a separate frontend state, not a reason for the engine to substitute
a different tool or alter a valid path.

Do not advertise capabilities until the configured model and engine have the
required implementation. Stale config, unsupported contract, invalid input and
execution failure all return structured errors. No mock fallback, fabricated tool
1, implicit zero radius, guessed target, or unknown-axis-as-zero behavior.

## 10. Numerical and integration gates

- Same two-channel payload through CGI and FastAPI: one engine execution per
  request, equivalent profiles, centre coordinates, poses and error envelopes.
- Profile revision mismatch and invalid range overlap reject before execution;
  unsupported pose-mode BYOC is rejected rather than ignored.
- Numeric 1 versus named "1", zero/unload semantics, STAR subtools and buffered
  tool/offset changes retain the correct per-movement identity.
- Known G41/G42 fixtures change coordinates by the expected radius once; G40
  flushes with the captured context. Turning Q/nose cases stay gated until tested.
- Inch/metric and diameter/radius fixtures yield identical physical mm geometry
  for equivalent programs. Missing modes are rejected, not reinterpreted.
- Work-offset switches preserve one fixed material/workpiece frame. Missing raw
  machine-to-workpiece calibration fails instead of using identity transforms.
- With identity mounting, MILL DEMO B=90,C=0 maps assembly +Z to workpiece -X;
  B=90,C=90 maps +Z to +Y. B=0,C=90 maps assembly +X to -Y. Check full bases,
  not only tool-axis vectors, and include nonidentity mounting.
- A pure tool-side +90-degree Y rotation maps assembly +Z to +X for the explicitly
  defined test basis. This is not a claim about STAR's uncalibrated physical sign.
- A synthetic pivot at [10,0,0] rotating point [11,0,0] by +90 degrees about Z
  yields [10,1,0]; verify inverse workpiece transforms and no double rotation.
- Rotary-only, full-turn, sampled-arc and generated-cycle outputs retain enough
  ordered samples and all poses; no coordinate-based deduplication.
- Missing mounting may hide a mesh only with valid XYZ/reference. Unsupported
  TCP or unknown target needed for XYZ fails without a synthetic successful run.
- An empty legitimate execution succeeds without mock output. A demo fixture
  runs only by explicit selection and never consumes user NC as if it executed it.

After these gates, the frontend needs only a cached mesh lookup and an XYZ plus
quaternion assignment for endpoint selection. Mesh creation, material removal,
collision checking and full-machine animation are not backend pose calculations.