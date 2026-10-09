import type { RemovalMotion, SimulationInput } from '../../SimulationTypes';

export function traceInput(): SimulationInput {
  const motion = (
    step: number,
    mode: RemovalMotion['mode'],
    start: [number, number, number],
    end: [number, number, number],
  ): RemovalMotion => {
    const pose = (position: [number, number, number]) => ({
      position,
      orientation: [0, 0, 0, 1] as const,
      frameId: 'workpiece:trace',
      reference: mode === 'turning' ? ('turningVirtualTip' as const) : ('millingTip' as const),
    });
    return {
      mode,
      start: pose(start),
      end: pose(end),
      executionStep: step,
      lineNumber: 20,
      tool:
        mode === 'milling'
          ? {
              toolNumber: 1,
              description: 'Trace mill',
              cutting: [{ type: 'endMill', diameter: 0.8, length: 2 }],
            }
          : {
              toolNumber: 2,
              description: 'Trace insert',
              cutting: [
                {
                  type: 'insert',
                  shape: 'S',
                  ic: 2,
                  thickness: 0.5,
                  noseRadius: 0,
                  clearanceAngle: 0,
                  rotation: [0, 45, 0],
                },
              ],
            },
    };
  };
  return {
    algorithmVersion: 2,
    stock: { type: 'cylinder', diameter: 4, length: 4, zeroVertex: 1 },
    resolutionMm: 0.25,
    binding: {
      frameId: 'workpiece:trace',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      spindleOrigin: [0, 0, 0],
      spindleAxis: [0, 0, 1],
    },
    motions: [
      motion(1, 'turning', [1.6, 0, -4], [1.6, 0, 0]),
      motion(3, 'milling', [0.5, 0, 0], [0.5, 0, -1]),
      motion(5, 'turning', [1.3, 0, -4], [1.3, 0, 0]),
    ],
  };
}
