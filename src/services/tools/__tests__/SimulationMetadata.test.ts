import { describe, expect, it } from 'vitest';
import { validateProgramSetup, validateProgramTool } from '../SimulationMetadata';
import type { InsertShape } from '../SimulationMetadata';

const base = { toolNumber: 1, description: 'test' };

describe('simulation schema validation', () => {
  it.each<InsertShape>(['C', 'D', 'V', 'W', 'T', 'S', 'R', 'E', 'H', 'O', 'P', 'L', 'A', 'B', 'K'])(
    'retains insert shape %s rather than substituting a preview shape',
    (shape) => {
      const insert = {
        type: 'insert', shape, ic: 9.525, thickness: 3.97, noseRadius: 0.4,
        clearanceAngle: 7, position: [1, 2, 3], rotation: [0, 90, 0],
        ...(['L', 'A', 'B', 'K'].includes(shape) ? { width: 10, length: 20 } : {}),
      };
      expect(validateProgramTool({ ...base, cutting: [insert] }).cutting?.[0]).toEqual(insert);
    },
  );

  it('validates all initial holder and cutter primitives without converting transforms', () => {
    const tool = {
      ...base,
      orientation: [90, 0, -45],
      holder: [
        { type: 'box', width: 20, height: 20, length: 100, stickOut: 55 },
        { type: 'cylinder', diameter: 8, length: 35, position: [0, 0, 45] },
        { type: 'cone', startDiameter: 0, endDiameter: 20, length: 30 },
        { type: 'profile', points: [[0, 0], [0, 4], [20, 4], [20, 0]] },
      ],
      cutting: [
        { type: 'drill', diameter: 8, length: 45, tipAngle: 118 },
        { type: 'endMill', diameter: 8, length: 20, cornerRadius: 0 },
        { type: 'ballMill', diameter: 8, length: 4 },
      ],
    };
    expect(validateProgramTool(tool)).toEqual(tool);
  });

  it.each([
    { toolNumber: 'unknown' }, { toolNumber: -1 }, { toolNumber: 1.5 },
    { channelId: '1' }, { units: 'inch' }, { frame: 'world' },
    { orientation: [0, 0, Infinity] }, { Q: NaN }, { R: null },
    { holder: [{ type: 'box', width: 0, height: 20, length: 100 }] },
    { holder: [{ type: 'cone', startDiameter: 0, endDiameter: 0, length: 10 }] },
    { holder: [{ type: 'profile', points: [[10, 4], [0, 4]] }] },
    { holder: [{ type: 'profile', points: [[0, 0], [10, 0]] }] },
    { holder: [{ type: 'profile', points: [[0, 1], [0, 4]] }] },
    { holder: [
      { type: 'cylinder', diameter: 8, length: 10 },
      { type: 'cylinder', diameter: 8, length: 10, stickOut: 50 },
    ] },
    { cutting: [{ type: 'drill', diameter: 8, length: 1, tipAngle: 118 }] },
    { cutting: [{ type: 'drill', diameter: 8, length: 20, tipAngle: 180 }] },
    { cutting: [{ type: 'endMill', diameter: 8, length: 20, cornerRadius: 5 }] },
    { cutting: [{ type: 'ballMill', diameter: 8, length: 3 }] },
    { cutting: [{ type: 'custom', code: 'execute()' }] },
    { cutting: [{ type: 'insert', shape: 'L', ic: 8, thickness: 4, noseRadius: 0, clearanceAngle: 7 }] },
    { cutting: [{ type: 'insert', shape: 'M', ic: 8, thickness: 4, noseRadius: 0, clearanceAngle: 7 }] },
    { cutting: [{ type: 'insert', shape: 'C', ic: 8, thickness: 4, noseRadius: 5, clearanceAngle: 7 }] },
  ])('rejects invalid, ambiguous or unsupported geometry: %j', (patch) => {
    expect(() => validateProgramTool({ ...base, ...patch })).toThrow();
  });

  it.each([
    { type: 'box', width: -1, depth: 10, height: 10 },
    { type: 'cylinder', diameter: 0, length: 10 },
    { type: 'bar', diameter: 10, length: 10 },
    { type: 'cylinder', diameter: 10, radius: 5, length: 10 },
    { type: 'cylinder', diameter: 10, length: 10, position: [0, 0] },
    { type: 'box', width: 10, depth: 10, height: 10, units: 'inch' },
  ])('rejects material outside the fixed-mm centred schema: %j', (material) => {
    expect(() => validateProgramSetup({ machineName: 'MILL', material })).toThrow();
  });
});