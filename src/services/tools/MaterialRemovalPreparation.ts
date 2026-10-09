import * as THREE from 'three';
import type { ChannelId, PlotMetadata, PoseSample } from '@core/types';
import type { PlotRunInput } from './PlotRunSnapshot';
import type { DeepReadonly, ProgramMaterialDefinition } from './SimulationMetadata';
import { MetadataValidationError } from './SimulationMetadata';
import type { SimulationInput, StockBinding, RemovalStop } from '../simulation/SimulationTypes';
import { validateStockBinding, stockPlacement } from '../simulation/SimulationTransforms';
import { CuttingToolModel } from '../simulation/CuttingToolModel';
import { buildTurningEnvelope } from '../simulation/TurningEnvelope';
import { SimulationCapabilityError } from '../simulation/SimulationTypes';

export interface MaterialRemovalDiagnostic {
  code:
    | 'stock-conflict'
    | 'stock-frame-unresolved'
    | 'spindle-state-unavailable'
    | 'channel-order-unavailable'
    | 'motion-mode-unavailable'
    | 'tool-geometry-unavailable'
    | 'tool-pose-unavailable'
    | 'multiple-workpiece-frames'
    | 'turning-reference-unverified'
    | 'unsupported-operation';
  severity: 'warning' | 'error';
  message: string;
}

export interface MaterialRemovalPreparation {
  status: 'not-configured' | 'blocked' | 'ready';
  stock?: DeepReadonly<ProgramMaterialDefinition>;
  channelIds: ChannelId[];
  frameId?: string;
  diagnostics: MaterialRemovalDiagnostic[];
  simulation?: DeepReadonly<SimulationInput>;
}

function stockKey(stock: DeepReadonly<ProgramMaterialDefinition>): string {
  return JSON.stringify([
    stock.type,
    stock.type === 'box'
      ? [stock.width, stock.height, stock.depth]
      : [stock.diameter, stock.length],
    stock.position ?? [0, 0, 0],
    stock.rotation ?? [0, 0, 0],
    stock.zeroVertex ?? null,
  ]);
}

function validPose(pose: DeepReadonly<PoseSample> | undefined): pose is DeepReadonly<PoseSample> {
  return Boolean(
    pose &&
    Array.isArray(pose.position) &&
    pose.position.length === 3 &&
    pose.position.every(Number.isFinite) &&
    Array.isArray(pose.orientation) &&
    pose.orientation.length === 4 &&
    pose.orientation.every(Number.isFinite) &&
    Math.abs(Math.hypot(...pose.orientation) - 1) <= 1e-6 &&
    (pose.reference === 'millingTip' || pose.reference === 'turningVirtualTip') &&
    typeof pose.frameId === 'string' &&
    pose.frameId.length > 0,
  );
}

export function resolveMachineStockBinding(
  input: DeepReadonly<PlotRunInput>,
  frames: ReadonlySet<string>,
): DeepReadonly<StockBinding> | undefined {
  const config = input.machineProfile?.simulation;
  const bindings = config?.stockBindings;
  if (!config || bindings === undefined) return undefined;
  if (!Array.isArray(bindings) || bindings.length > 64)
    throw new Error('Machine stock bindings must be a list of at most 64 entries');
  const allowed = new Set(config.carriers
    .filter((carrier) => carrier.role === 'workpiece')
    .map((carrier) => `workpiece:${carrier.id}`));
  const seen = new Set<string>();
  for (const binding of bindings) {
    validateStockBinding(binding);
    if (!allowed.has(binding.frameId) || seen.has(binding.frameId))
      throw new Error('Machine stock binding references an unknown or duplicate workpiece frame');
    seen.add(binding.frameId);
  }
  if (frames.size !== 1) return undefined;
  return bindings.find((binding) => frames.has(binding.frameId));
}

export function prepareMaterialRemoval(
  inputs: DeepReadonly<PlotRunInput[]>,
  metadata: DeepReadonly<PlotMetadata>,
  setup?: DeepReadonly<{ binding: StockBinding; resolutionMm: number }>,
): MaterialRemovalPreparation {
  const materials = inputs.flatMap((input) =>
    input.snapshot.setup?.material ? [input.snapshot.setup.material] : [],
  );
  const channelIds = inputs.map((input) => input.snapshot.identity.channelId);
  if (!materials.length) return { status: 'not-configured', channelIds, diagnostics: [] };
  const diagnostics: MaterialRemovalDiagnostic[] = [];
  const add = (
    code: MaterialRemovalDiagnostic['code'],
    message: string,
    severity: 'error' | 'warning' = 'error',
  ) => {
    if (!diagnostics.some((diagnostic) => diagnostic.code === code))
      diagnostics.push({ code, message, severity });
  };
  if (materials.some((stock) => stockKey(stock) !== stockKey(materials[0]))) {
    add(
      'stock-conflict',
      'Channel material definitions conflict; select one shared physical stock before removal.',
    );
    return { status: 'blocked', channelIds, diagnostics };
  }
  const stock = materials[0];
  add(
    'spindle-state-unavailable',
    'Geometric preview: supported feed motions are assumed cutting; spindle operation is not verified. Rapids do not remove stock.',
    'warning',
  );
  if (inputs.length !== 1) {
    add(
      'channel-order-unavailable',
      'Simulate one channel at a time; channel-local steps do not establish shared cutting order.',
    );
  }
  let configured = setup ?? inputs[0]?.materialSimulation;
  const frames = new Set(
    metadata.segments.flatMap(
      (segment) => segment.poses?.filter(validPose).map((pose) => pose.frameId) ?? [],
    ),
  );
  const frameId = frames.size === 1 ? [...frames][0] : undefined;
  if (!configured && inputs.length === 1) {
    const binding = resolveMachineStockBinding(inputs[0], frames);
    if (binding) configured = { binding, resolutionMm: 0.05 };
  }
  if (!configured) {
    add(
      'stock-frame-unresolved',
      'Stock is a program-coordinate preview; no matching backend stock binding is available. Configure stockBindings in the backend machine definition or supply an explicit program stock binding.',
    );
    return { status: 'blocked', stock, channelIds, frameId, diagnostics };
  }
  validateStockBinding(configured.binding);
  if (
    !Number.isFinite(configured.resolutionMm) ||
    configured.resolutionMm < 0.05 ||
    configured.resolutionMm > 5
  ) {
    throw new Error('Voxel resolution must be between 0.05 and 5 mm');
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { status: 'blocked', stock, channelIds, frameId, diagnostics };
  }

  const simulation: SimulationInput = {
    algorithmVersion: 2,
    stock: structuredClone(stock),
    binding: structuredClone(configured.binding),
    resolutionMm: configured.resolutionMm,
    motions: [],
  };
  const tools = new Map(inputs[0].snapshot.tools.map((tool) => [tool.toolNumber, tool]));
  const explicitTools = new Set(
    inputs[0].snapshot.geometry
      .filter((geometry) => geometry.status === 'single-cutter')
      .map((geometry) => geometry.toolNumber),
  );
  const inverse = stockPlacement(stock, configured.binding).invert();
  const spindleOrigin = new THREE.Vector3(...configured.binding.spindleOrigin).applyMatrix4(
    inverse,
  );
  const spindleAxis = new THREE.Vector3(...configured.binding.spindleAxis).transformDirection(
    inverse,
  );
  const cutters = new Map<string, CuttingToolModel>();
  const capturedTools = new Map([...tools].map(([id, tool]) => [id, structuredClone(tool)]));
  const rawStop = metadata.removalStops?.find((stop) => stop.channelId === channelIds[0]);
  const stopAt = (
    code: MaterialRemovalDiagnostic['code'],
    message: string,
    stop: RemovalStop,
  ): void => {
    add(code, message);
    simulation.stop = { ...stop, message };
  };
  for (const segment of metadata.segments) {
    if (rawStop && (segment.sourceSegmentIndex ?? Infinity) > rawStop.sourceSegmentIndex) {
      stopAt('unsupported-operation', rawStop.message, {
        executionStep: rawStop.executionStep ?? undefined,
        lineNumber: rawStop.lineNumber,
        message: rawStop.message,
      });
      break;
    }
    if (segment.type === 'rapid') continue;
    const context = {
      executionStep: segment.executionStep ?? undefined,
      lineNumber: segment.startPoint.lineNumber,
      message: '',
    };
    if (segment.machiningMode !== 'milling' && segment.machiningMode !== 'turning') {
      stopAt('motion-mode-unavailable', 'Feed motion has no resolved machining mode', context);
      break;
    }
    if (segment.sourceCode && !/^G0?[0123]$/i.test(segment.sourceCode)) {
      stopAt(
        'unsupported-operation',
        `Removal does not support ${segment.sourceCode} (threading/compound operations are excluded)`,
        context,
      );
      break;
    }
    if (
      segment.motionContext?.endAxes &&
      segment.motionContext.startAxes &&
      Object.entries(segment.motionContext.endAxes).some(
        ([axis, value]) =>
          /^[ABC]\d*$/.test(axis) &&
          segment.motionContext?.startAxes[axis] !== undefined &&
          Math.abs(value - segment.motionContext.startAxes[axis]) /
            Math.max(1, (segment.poses?.length ?? 0) - 1) >=
            180 - 1e-6,
      )
    ) {
      stopAt(
        'unsupported-operation',
        'Rotary motion is not sufficiently sampled to resolve its angular travel',
        context,
      );
      break;
    }
    if (!Number.isSafeInteger(segment.executionStep) || segment.executionStep! < 0) {
      stopAt('unsupported-operation', 'Motion has no valid execution occurrence', context);
      break;
    }
    const tool =
      segment.toolNumber !== null && segment.toolNumber !== undefined
        ? tools.get(segment.toolNumber)
        : undefined;
    if (tool?.cutting?.length !== 1 || !explicitTools.has(tool.toolNumber)) {
      stopAt(
        'tool-geometry-unavailable',
        'Motion requires one explicit run-owned cutting part',
        context,
      );
      break;
    }
    const index = segment.subsegmentIndex;
    const start = index === undefined ? undefined : segment.poses?.[index];
    const end = index === undefined ? undefined : segment.poses?.[index + 1];
    if (!validPose(start) || !validPose(end)) {
      stopAt(
        'tool-pose-unavailable',
        'Motion has missing or invalid aligned start/end poses',
        context,
      );
      break;
    }
    if (
      start.frameId !== configured.binding.frameId ||
      end.frameId !== configured.binding.frameId
    ) {
      stopAt(
        'multiple-workpiece-frames',
        'Motion targets a different workpiece frame; transfer is not supported',
        context,
      );
      break;
    }
    const turning = segment.machiningMode === 'turning';
    const reference = turning ? 'turningVirtualTip' : 'millingTip';
    if (
      start.reference !== reference ||
      end.reference !== reference ||
      turning !== (tool.cutting[0].type === 'insert')
    ) {
      stopAt(
        'turning-reference-unverified',
        'Machining mode, cutter type and pose reference do not agree',
        context,
      );
      break;
    }
    const executedQ = segment.motionContext?.toolOffset?.tipOrientation;
    const key = JSON.stringify([typeof tool.toolNumber, tool.toolNumber, executedQ]);
    let cutter = cutters.get(key);
    try {
      if (!cutter) {
        cutter = new CuttingToolModel(structuredClone(tool), executedQ);
        cutters.set(key, cutter);
      }
      if (turning) {
        const radiusMode = segment.motionContext?.toolOffset?.radiusMode;
        if (radiusMode && radiusMode !== 'OFF' && radiusMode !== 'G40') {
          throw new SimulationCapabilityError(
            'Compensated turning nose/reference semantics are not supported by this preview',
          );
        }
        if (
          new THREE.Quaternion(...start.orientation).angleTo(
            new THREE.Quaternion(...end.orientation),
          ) > 1e-6
        ) {
          throw new SimulationCapabilityError(
            'Changing insert orientation during turning is not supported',
          );
        }
        for (const pose of [start, end]) {
          const matrix = inverse
            .clone()
            .multiply(
              new THREE.Matrix4().compose(
                new THREE.Vector3(...pose.position),
                new THREE.Quaternion(...pose.orientation),
                new THREE.Vector3(1, 1, 1),
              ),
            );
          buildTurningEnvelope(cutter, matrix, spindleOrigin, spindleAxis);
        }
      }
    } catch (error) {
      if (
        !(error instanceof SimulationCapabilityError) &&
        !(error instanceof MetadataValidationError)
      )
        throw error;
      stopAt(
        turning ? 'turning-reference-unverified' : 'tool-geometry-unavailable',
        error.message,
        context,
      );
      break;
    }
    simulation.motions.push({
      mode: segment.machiningMode,
      start: structuredClone(start),
      end: structuredClone(end),
      tool: capturedTools.get(tool.toolNumber)!,
      executedQ,
      executionStep: segment.executionStep!,
      lineNumber: segment.startPoint.lineNumber,
    });
  }
  if (!simulation.stop && rawStop) {
    stopAt('unsupported-operation', rawStop.message, {
      executionStep: rawStop.executionStep ?? undefined,
      lineNumber: rawStop.lineNumber,
      message: rawStop.message,
    });
  }
  return {
    status: 'ready',
    stock,
    channelIds,
    frameId: configured.binding.frameId,
    diagnostics,
    simulation,
  };
}
