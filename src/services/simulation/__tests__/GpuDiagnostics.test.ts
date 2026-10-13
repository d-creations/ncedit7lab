import { describe, expect, it } from 'vitest';
import {
  gpuDiagnosticSnapshot,
  gpuDiagnosticContext,
  recordGpuDiagnostic,
} from '../GpuDiagnostics';

describe('GPU diagnostics', () => {
  it('does not attach previous calculation timings or errors to newly started work', () => {
    const device = {};
    recordGpuDiagnostic(device, 'compute-start', { intervalCapacity: 4 });
    recordGpuDiagnostic(device, 'compute-first-complete', { submitCpuMs: 100 });
    recordGpuDiagnostic(device, 'compute-finished', { elapsedMs: 200 });
    recordGpuDiagnostic(device, 'compute-error', { message: 'old failure' });
    recordGpuDiagnostic(device, 'compute-start', { intervalCapacity: 8 });
    expect(gpuDiagnosticContext(device).map((event) => event.phase)).toEqual(['compute-start']);
    expect(gpuDiagnosticContext(device)[0].details.intervalCapacity).toBe(8);
  });
  it('keeps adapter and latest calculation context after render traffic evicts breadcrumbs', () => {
    const device = {};
    recordGpuDiagnostic(device, 'initialized', { vendor: 'test' });
    recordGpuDiagnostic(device, 'compute-start', { rays: 100 });
    recordGpuDiagnostic(device, 'compute-start', { rays: 200 });
    for (let i = 0; i < 30; i++) recordGpuDiagnostic(device, 'render-submit');
    expect(gpuDiagnosticSnapshot(device).every((event) => event.phase === 'render-submit')).toBe(
      true,
    );
    expect(gpuDiagnosticContext(device).map((event) => event.details)).toEqual([
      { vendor: 'test' },
      { rays: 200 },
    ]);
    gpuDiagnosticContext(device)[1].details.rays = 999;
    expect(gpuDiagnosticContext(device)[1].details.rays).toBe(200);
    expect(gpuDiagnosticContext({})).toEqual([]);
  });
  it('bounds history and isolates devices', () => {
    const device = {},
      other = {};
    for (let i = 0; i < 30; i++) recordGpuDiagnostic(device, 'compute-submit', { offset: i });
    const snapshot = gpuDiagnosticSnapshot(device);
    expect(snapshot).toHaveLength(24);
    expect(snapshot[0].details.offset).toBe(6);
    expect(snapshot[23].details.offset).toBe(29);
    expect(gpuDiagnosticSnapshot(other)).toEqual([]);
  });
  it('copies metadata on recording and snapshotting', () => {
    const device = {},
      details = { rays: 64 };
    recordGpuDiagnostic(device, 'compute-submit', details);
    details.rays = 999;
    const snapshot = gpuDiagnosticSnapshot(device);
    snapshot[0].details.rays = 100;
    expect(gpuDiagnosticSnapshot(device)[0].details.rays).toBe(64);
  });
});
