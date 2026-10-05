import type { ChannelId, PlotMetadata, PoseSample } from '@core/types';
import type { PlotRunInput } from './PlotRunSnapshot';
import type { DeepReadonly, ProgramMaterialDefinition } from './SimulationMetadata';

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
    | 'turning-reference-unverified';
  message: string;
}

export interface MaterialRemovalPreparation {
  status: 'not-configured' | 'blocked';
  /** One initial stock definition, never one evolving stock per channel. */
  stock?: DeepReadonly<ProgramMaterialDefinition>;
  channelIds: ChannelId[];
  frameId?: string;
  diagnostics: MaterialRemovalDiagnostic[];
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

function validPose(pose: DeepReadonly<PoseSample> | undefined): boolean {
  return Boolean(pose &&
    Array.isArray(pose.position) && pose.position.length === 3 && pose.position.every(Number.isFinite) &&
    Array.isArray(pose.orientation) && pose.orientation.length === 4 && pose.orientation.every(Number.isFinite) &&
    Math.abs(Math.hypot(...pose.orientation) - 1) <= 1e-6 &&
    (pose.reference === 'millingTip' || pose.reference === 'turningVirtualTip') &&
    typeof pose.frameId === 'string' && pose.frameId.length > 0);
}

/** Preflight only: a plotted mesh and a machining mode do not authorize subtraction. */
export function prepareMaterialRemoval(
  inputs: DeepReadonly<PlotRunInput[]>,
  metadata: DeepReadonly<PlotMetadata>,
): MaterialRemovalPreparation {
  const materials = inputs.flatMap((input) => input.snapshot.setup?.material
    ? [input.snapshot.setup.material]
    : []);
  const channelIds = inputs.map((input) => input.snapshot.identity.channelId);
  if (!materials.length) return { status: 'not-configured', channelIds, diagnostics: [] };
  if (materials.some((stock) => stockKey(stock) !== stockKey(materials[0]))) {
    return {
      status: 'blocked', channelIds,
      diagnostics: [{
        code: 'stock-conflict',
        message: 'Channel material definitions conflict; select one shared physical stock before removal.',
      }],
    };
  }

  const diagnostics: MaterialRemovalDiagnostic[] = [];
  const add = (code: MaterialRemovalDiagnostic['code'], message: string): void => {
    if (!diagnostics.some((diagnostic) => diagnostic.code === code)) diagnostics.push({ code, message });
  };
  add('stock-frame-unresolved',
    'Stock is a program-coordinate preview; its fixed workpiece-frame transform is not supplied.');
  add('spindle-state-unavailable',
    'The response identifies machining mode, but does not verify the active cutting spindle.');
  if (inputs.length > 1) {
    add('channel-order-unavailable',
      'Channel-local execution steps do not establish a shared cutting order for one stock.');
  }
  const frames = new Set<string>();
  const channelTools = new Map(inputs.map((input) => [
    input.snapshot.identity.channelId,
    new Map(input.snapshot.tools.map((tool) => [tool.toolNumber, tool])),
  ]));
  for (const segment of metadata.segments) {
    if (segment.type === 'rapid') continue;
    if (!segment.machiningMode || segment.machiningMode === 'unknown') {
      add('motion-mode-unavailable', 'Some feed motions have no resolved machining mode.');
    }
    const tool = segment.channelId !== undefined && segment.toolNumber !== null && segment.toolNumber !== undefined
      ? channelTools.get(segment.channelId)?.get(segment.toolNumber)
      : undefined;
    if (!tool?.cutting?.length) {
      add('tool-geometry-unavailable', 'Some feed motions have no run-owned cutting geometry.');
    }
    const index = segment.subsegmentIndex;
    const start = index === undefined ? undefined : segment.poses?.[index];
    const end = index === undefined ? undefined : segment.poses?.[index + 1];
    if (!validPose(start) || !validPose(end)) {
      add('tool-pose-unavailable', 'Some feed motions have missing or invalid aligned start and end tool poses.');
    }
    for (const pose of [start, end]) {
      if (pose && validPose(pose)) frames.add(pose.frameId);
    }
    if (segment.machiningMode === 'turning') {
      add('turning-reference-unverified',
        'Turning insert placement needs verified executed nose/Q and virtual-tip semantics before removal.');
    }
  }
  if (frames.size > 1) {
    add('multiple-workpiece-frames',
      'Feed motions target different workpiece frames; stock transfer/binding is unresolved.');
  }
  return {
    status: 'blocked', stock: materials[0], channelIds,
    frameId: frames.size === 1 ? frames.values().next().value : undefined,
    diagnostics,
  };
}
