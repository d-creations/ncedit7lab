interface GpuDiagnosticEvent {
  phase: string;
  timeMs: number;
  details: Record<string, string | number | boolean>;
}

const histories = new WeakMap<object, GpuDiagnosticEvent[]>();
const contexts = new WeakMap<object, Map<string, GpuDiagnosticEvent>>();

export function recordGpuDiagnostic(
  device: object,
  phase: string,
  details: GpuDiagnosticEvent['details'] = {},
): void {
  const history = histories.get(device) ?? [];
  history.push({ phase, timeMs: Math.round(performance.now()), details: { ...details } });
  if (history.length > 24) history.shift();
  histories.set(device, history);
  if (
    [
      'initialized',
      'compute-start',
      'compute-first-complete',
      'compute-finished',
      'compute-error',
      'frame-preparation',
      'replay-preparation',
      'history-restored',
      'history-restore-start',
      'stock-copy-start',
      'stock-copy-finished',
    ].includes(phase)
  ) {
    const context = contexts.get(device) ?? new Map<string, GpuDiagnosticEvent>();
    if (phase === 'compute-start') {
      context.delete('compute-first-complete');
      context.delete('compute-finished');
      context.delete('compute-error');
    }
    context.set(phase, history[history.length - 1]);
    contexts.set(device, context);
  }
}

export function gpuDiagnosticContext(device: object): readonly GpuDiagnosticEvent[] {
  return [...(contexts.get(device)?.values() ?? [])].map((event) => ({
    ...event,
    details: { ...event.details },
  }));
}

export function gpuDiagnosticSnapshot(device: object): readonly GpuDiagnosticEvent[] {
  return (histories.get(device) ?? []).map((event) => ({
    ...event,
    details: { ...event.details },
  }));
}
