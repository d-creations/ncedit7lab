import * as THREE from 'three';
import type { ChannelId, PlotMetadata, PlotSegment, PoseSample } from '@core/types';
import type { PlotRunInput } from './PlotRunSnapshot';
import type { DeepReadonly, ProgramMaterialDefinition } from './SimulationMetadata';
import { MetadataValidationError } from './SimulationMetadata';
import type { SimulationInput, StockBinding, RemovalStop } from '../simulation/shared/SimulationTypes';
import {
  validateStockBinding,
  stockPlacement,
  getChannelMaterialReference,
} from '../simulation/shared/SimulationTransforms';
import { CuttingToolModel } from '../simulation/shared/CuttingToolModel';
import { buildTurningEnvelope } from '../simulation/shared/TurningEnvelope';
import { SimulationCapabilityError } from '../simulation/shared/SimulationTypes';

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

export function stockKey(stock: DeepReadonly<ProgramMaterialDefinition>): string {
  return JSON.stringify([
    stock.type,
    stock.type === 'box'
      ? [stock.width, stock.height, stock.depth]
      : [stock.diameter, stock.length],
    stock.position ?? [0, 0, 0],
    stock.rotation ?? [0, 0, 0],
    stock.zeroVertex ?? null,
    (['1', '2', '3'] as const).map((channelId) => {
      const ref = getChannelMaterialReference(stock, channelId);
      return [ref.zeroVertex ?? null, ref.position ?? [0, 0, 0], ref.rotation ?? [0, 0, 0]];
    }),
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

function supportsRemovalSource(segment: DeepReadonly<PlotSegment>): boolean {
  const sourceCode = segment.sourceCode?.toUpperCase();
  if (!sourceCode || /^G0?[0123]$/.test(sourceCode)) return true;
  if (sourceCode === 'G161') return segment.type === 'feed';
  return (sourceCode === 'G162' || sourceCode === 'G163') && segment.type === 'arc';
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
  const hasMultiChannelSetup =
    Boolean(stock.channelReferences && Object.keys(stock.channelReferences).length > 0) ||
    Boolean(setup) ||
    inputs.some((input) =>
      Boolean(input.materialSimulation || input.machineProfile?.simulation?.stockBindings?.length),
    );
  if (inputs.length !== 1 && !hasMultiChannelSetup) {
    add(
      'channel-order-unavailable',
      'Simulate one channel at a time; channel-local steps do not establish shared cutting order.',
    );
  }
  let configured = setup ?? inputs.find((input) => input.materialSimulation)?.materialSimulation;
  const frames = new Set(
    metadata.segments.flatMap(
      (segment) => segment.poses?.filter(validPose).map((pose) => pose.frameId) ?? [],
    ),
  );
  const frameId = frames.size === 1 ? [...frames][0] : undefined;
  if (!configured && (inputs.length === 1 || hasMultiChannelSetup)) {
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
  const toolsByChannel = new Map(
    inputs.map((input) => [
      input.snapshot.identity.channelId,
      new Map(input.snapshot.tools.map((tool) => [tool.toolNumber, structuredClone(tool)])),
    ]),
  );
  const explicitToolsByChannel = new Map(
    inputs.map((input) => [
      input.snapshot.identity.channelId,
      new Set(
        input.snapshot.geometry
          .filter((geometry) => geometry.status === 'single-cutter')
          .map((geometry) => geometry.toolNumber),
      ),
    ]),
  );
  const emptyToolsByChannel = new Map(
    inputs.map((input) => [
      input.snapshot.identity.channelId,
      new Set(
        input.snapshot.geometry
          .filter((geometry) => geometry.status === 'missing')
          .map((geometry) => geometry.toolNumber),
      ),
    ]),
  );
  const fallbackTools = new Map(
    inputs.flatMap((input) =>
      input.snapshot.tools.map((tool) => [tool.toolNumber, structuredClone(tool)] as const),
    ),
  );
  const fallbackExplicitTools = new Set(
    inputs.flatMap((input) =>
      input.snapshot.geometry
        .filter((geometry) => geometry.status === 'single-cutter')
        .map((geometry) => geometry.toolNumber),
    ),
  );
  const inverse = stockPlacement(stock, configured.binding).invert();
  const spindleOrigin = new THREE.Vector3(...configured.binding.spindleOrigin).applyMatrix4(
    inverse,
  );
  const spindleAxis = new THREE.Vector3(...configured.binding.spindleAxis).transformDirection(
    inverse,
  );
  const cutters = new Map<string, CuttingToolModel>();
  const hasSelectedToolId = (toolNumber: PlotSegment['toolNumber']): boolean =>
    toolNumber !== undefined &&
    toolNumber !== null &&
    toolNumber !== 'unknown' &&
    toolNumber !== 0 &&
    toolNumber !== '0' &&
    toolNumber !== '';
  const rawStopByChannel = new Map(
    channelIds.map((chId) => {
      const channelSegments = metadata.segments.filter(
        (segment) => (segment.channelId ?? channelIds[0]) === chId,
      );
      const firstToolSegment = channelSegments.find((segment) =>
        hasSelectedToolId(segment.toolNumber),
      );
      const hasPreToolSegments =
        firstToolSegment !== undefined &&
        channelSegments.some(
          (segment) =>
            !hasSelectedToolId(segment.toolNumber) &&
            (segment.sourceSegmentIndex ?? Infinity) <
              (firstToolSegment.sourceSegmentIndex ?? Infinity),
        );
      const firstToolSourceSegmentIndex = hasPreToolSegments
        ? (firstToolSegment?.sourceSegmentIndex ?? 0)
        : 0;
      const rawStop = metadata.removalStops?.find(
        (stop) =>
          stop.channelId === chId &&
          stop.sourceSegmentIndex >= firstToolSourceSegmentIndex,
      );
      return [chId, rawStop] as const;
    }),
  );
  const stopAt = (
    code: MaterialRemovalDiagnostic['code'],
    message: string,
    stop: RemovalStop,
  ): void => {
    add(code, message);
    simulation.stop = { ...stop, message };
  };
  const hasSelectedToolByChannel = new Map<ChannelId, boolean>();
  for (const segment of metadata.segments) {
    const segChannel = segment.channelId ?? channelIds[0];
    if (hasSelectedToolId(segment.toolNumber)) {
      hasSelectedToolByChannel.set(segChannel, true);
    }
    const rawStop = rawStopByChannel.get(segChannel);
    if (rawStop && (segment.sourceSegmentIndex ?? Infinity) > rawStop.sourceSegmentIndex) {
      stopAt('unsupported-operation', rawStop.message, {
        executionStep: rawStop.executionStep ?? undefined,
        lineNumber: rawStop.lineNumber,
        message: rawStop.message,
      });
      break;
    }
    const channelEmptyTools = emptyToolsByChannel.get(segChannel);
    const channelExplicitTools = explicitToolsByChannel.get(segChannel);
    const channelTools = toolsByChannel.get(segChannel);
    const isNoToolActive =
      !hasSelectedToolByChannel.get(segChannel) ||
      segment.toolNumber === 'unknown' ||
      segment.toolNumber === 0 ||
      segment.toolNumber === '0' ||
      (segment.toolNumber !== null &&
        segment.toolNumber !== undefined &&
        Boolean(channelEmptyTools?.has(segment.toolNumber)) &&
        !fallbackExplicitTools.has(segment.toolNumber));
    if (segment.type === 'rapid' || isNoToolActive) continue;
    const context = {
      executionStep: segment.executionStep ?? undefined,
      lineNumber: segment.startPoint.lineNumber,
      message: '',
    };
    if (segment.machiningMode !== 'milling' && segment.machiningMode !== 'turning') {
      stopAt('motion-mode-unavailable', 'Feed motion has no resolved machining mode', context);
      break;
    }
    if (!supportsRemovalSource(segment)) {
      stopAt(
        'unsupported-operation',
        `Removal does not support ${segment.sourceCode} as ${segment.type} motion`,
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
    const hasChannelExplicit =
      segment.toolNumber !== null &&
      segment.toolNumber !== undefined &&
      Boolean(channelExplicitTools?.has(segment.toolNumber));
    const tool =
      segment.toolNumber !== null && segment.toolNumber !== undefined
        ? hasChannelExplicit
          ? channelTools?.get(segment.toolNumber)
          : fallbackExplicitTools.has(segment.toolNumber)
            ? fallbackTools.get(segment.toolNumber)
            : channelTools?.get(segment.toolNumber) ?? fallbackTools.get(segment.toolNumber)
        : undefined;
    const isExplicitTool =
      segment.toolNumber !== null &&
      segment.toolNumber !== undefined &&
      (hasChannelExplicit || fallbackExplicitTools.has(segment.toolNumber));
    if (tool?.cutting?.length !== 1 || !isExplicitTool) {
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
    const isInsert = tool.cutting[0].type === 'insert';
    const stationarySpindleDrill =
      segment.machiningMode === 'turning' &&
      !isInsert &&
      start.reference === 'millingTip' &&
      end.reference === 'millingTip';
    let effectiveMode: 'turning' | 'milling' = segment.machiningMode;
    if (stationarySpindleDrill) {
      const checkCoaxial = () => {
        if (
          new THREE.Quaternion(...start.orientation).angleTo(
            new THREE.Quaternion(...end.orientation),
          ) > 1e-6
        )
          return false;
        const c = new CuttingToolModel(structuredClone(tool), undefined);
        for (const pose of [start, end]) {
          const matrix = inverse
            .clone()
            .multiply(
              new THREE.Matrix4().compose(
                new THREE.Vector3(...pose.position),
                new THREE.Quaternion(...pose.orientation),
                new THREE.Vector3(1, 1, 1),
              ),
            )
            .multiply(c.partToAssembly);
          const pos = new THREE.Vector3().setFromMatrixPosition(matrix);
          const dir = new THREE.Vector3(0, 0, 1).transformDirection(matrix);
          const rel = pos.sub(spindleOrigin);
          const radial = rel.clone().sub(spindleAxis.clone().multiplyScalar(rel.dot(spindleAxis)));
          if (radial.length() > 1e-6 || Math.abs(Math.abs(dir.dot(spindleAxis)) - 1) > 1e-6)
            return false;
        }
        return true;
      };
      if (checkCoaxial()) effectiveMode = 'milling';
    }
    const turning = effectiveMode === 'turning';
    const validReference = isInsert
      ? turning
        ? start.reference === 'turningVirtualTip' && end.reference === 'turningVirtualTip'
        : start.reference === end.reference &&
          (start.reference === 'turningVirtualTip' || start.reference === 'millingTip')
      : !turning && start.reference === 'millingTip' && end.reference === 'millingTip';
    if (!validReference) {
      stopAt(
        'turning-reference-unverified',
        'Machining mode, cutter type and pose reference do not agree',
        context,
      );
      break;
    }
    const executedQ = segment.motionContext?.toolOffset?.tipOrientation;
    const key = JSON.stringify([segChannel, typeof tool.toolNumber, tool.toolNumber, executedQ]);
    let cutter = cutters.get(key);
    try {
      if (!cutter) {
        cutter = new CuttingToolModel(structuredClone(tool), executedQ);
        cutters.set(key, cutter);
      }
      if (turning) {
        const radiusMode = segment.motionContext?.toolOffset?.radiusMode;
        if (radiusMode && radiusMode !== 'OFF' && radiusMode !== 'G40') {
          const offset = segment.motionContext?.toolOffset;
          const verified = [start, end].every((pose) => {
            const resolved = pose.turningReference;
            return resolved?.kind === 'resolved-center-path-v1' &&
              (radiusMode === 'LEFT' || radiusMode === 'RIGHT') &&
              resolved.radiusMode === radiusMode &&
              resolved.tipOrientation === executedQ &&
              Number.isInteger(executedQ) && executedQ! >= 0 && executedQ! <= 9 &&
              Number.isFinite(offset?.radius) && offset!.radius! >= 0 &&
              resolved.compensationRadius === offset?.radius &&
              tool.cutting![0].type === 'insert' &&
              resolved.noseRadius === tool.cutting![0].noseRadius &&
              Array.isArray(resolved.tipPosition) &&
              resolved.tipPosition.length === 3 &&
              resolved.tipPosition.every((value, axis) =>
                value === (tool.cutting![0].position ?? [0, 0, 0])[axis],
              );
          });
          if (!verified)
            throw new SimulationCapabilityError(
              'Compensated turning requires backend-resolved virtual-tip poses',
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
      mode: effectiveMode,
      start: structuredClone(start),
      end: structuredClone(end),
      tool,
      executedQ,
      executionStep: segment.executionStep!,
      lineNumber: segment.startPoint.lineNumber,
    });
  }
  if (!simulation.stop) {
    const trailingStop = [...rawStopByChannel.values()].find((stop) => stop !== undefined);
    if (trailingStop) {
      stopAt('unsupported-operation', trailingStop.message, {
        executionStep: trailingStop.executionStep ?? undefined,
        lineNumber: trailingStop.lineNumber,
        message: trailingStop.message,
      });
    }
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
