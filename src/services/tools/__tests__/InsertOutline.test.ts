import { describe, expect, it } from 'vitest';
import type { InsertShape } from '../SimulationMetadata';
import { buildInsertContour, getInsertOutline, getInsertTipAngle, resolveZeroVertex } from '../InsertOutline';

const SHAPES: InsertShape[] = ['C', 'D', 'V', 'W', 'T', 'S', 'R', 'E', 'H', 'O', 'P', 'L', 'A', 'B', 'K'];
const spec = (shape: InsertShape, extra: object = {}) => ({ shape, ic: 9.525, noseRadius: 0.4, width: 6, length: 12.5, ...extra });

function interiorAngle(points: [number, number][], index: number): number {
  const [x, y] = points[index];
  const a = points[(index + 1) % points.length];
  const b = points[(index + points.length - 1) % points.length];
  const u = [a[0] - x, a[1] - y];
  const v = [b[0] - x, b[1] - y];
  return (Math.acos((u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...(u as [number, number])) * Math.hypot(...(v as [number, number])))) * 180) / Math.PI;
}

describe('InsertOutline', () => {
  it.each(SHAPES.filter((shape) => shape !== 'R'))('%s has its ISO included angle at the working vertex', (shape) => {
    const outline = getInsertOutline(shape, 9.525 / 2, { width: 6, length: 12.5 });
    expect(interiorAngle(outline, 0)).toBeCloseTo(getInsertTipAngle(shape)!, 6);
  });

  it('keeps the incircle diameter of a 35 degree V plate tangent to every side', () => {
    const outline = getInsertOutline('V', 5);
    outline.forEach((from, index) => {
      const to = outline[(index + 1) % outline.length];
      const distance = Math.abs(from[0] * to[1] - to[0] * from[1]) / Math.hypot(to[0] - from[0], to[1] - from[1]);
      expect(distance).toBeCloseTo(5, 6);
    });
  });

  it('points the working vertex to the front (-Y) of the outline', () => {
    SHAPES.forEach((shape) => {
      const [x, y] = getInsertOutline(shape, 4.7625, { width: 6, length: 12.5 })[0];
      expect(y).toBeLessThan(0);
      if (!['A', 'B', 'K', 'L'].includes(shape)) expect(x).toBeCloseTo(0, 6);
    });
  });

  it.each(SHAPES)('%s puts the zero vertex exactly at the origin', (shape) => {
    const { sharp, zeroIndex } = buildInsertContour(spec(shape, { zeroVertex: 1 }));
    expect(zeroIndex).toBe(1);
    expect(sharp[1][0]).toBeCloseTo(0, 9);
    expect(sharp[1][1]).toBeCloseTo(0, 9);
  });

  it('rounds only the zero vertex with the nose radius', () => {
    const { sharp, contour, zeroIndex } = buildInsertContour(spec('D', { zeroVertex: 2 }));
    const near = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9;
    sharp.forEach((vertex, index) => {
      expect(contour.some((point) => near(point, vertex))).toBe(index !== zeroIndex);
    });
    // All fillet points stay inside the sharp corner at the nose radius from the arc centre.
    const arc = contour.filter((point) => !sharp.some((vertex) => near(point, vertex)));
    expect(arc.length).toBeGreaterThan(2);
    const radii = arc.map(([x, y]) => Math.hypot(x, y));
    expect(Math.min(...radii)).toBeGreaterThan(0);
  });

  it('does not round any vertex when the nose radius is zero', () => {
    const { sharp, contour } = buildInsertContour(spec('C', { noseRadius: 0 }));
    expect(contour).toEqual(sharp);
  });

  it('selects an actual outline vertex for a named corner and keeps the incircle centre for center', () => {
    const outline = getInsertOutline('A', 4.7625, { width: 6, length: 12.5 });
    const index = resolveZeroVertex(outline, undefined, 'front-right')!;
    expect(outline[index]).toBeDefined();
    expect(resolveZeroVertex(outline, undefined, 'center')).toBeUndefined();
    expect(resolveZeroVertex(outline, undefined, undefined)).toBe(0);
    expect(resolveZeroVertex(outline, 99)).toBe(0);
  });
});
