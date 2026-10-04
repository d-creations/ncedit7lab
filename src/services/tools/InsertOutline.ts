import type { InsertShape, TurningActiveCorner } from './SimulationMetadata';

export type Point2 = [number, number];

export interface InsertContourSpec {
  shape: InsertShape;
  ic: number;
  noseRadius: number;
  width?: number;
  length?: number;
  zeroVertex?: number;
}

export interface InsertContour {
  /** Sharp ISO outline, shifted so the zero vertex is (0,0). */
  sharp: Point2[];
  /** Solid outline: only the zero (cutting) vertex carries the nose radius. */
  contour: Point2[];
  /** Undefined means the incircle centre is the origin. */
  zeroIndex: number | undefined;
  /** Center of the nose radius fillet arc, if filleted */
  radiusCenter?: Point2;
}

/** Included angle of vertex 0, the working corner. */
const TIP_ANGLES: Record<InsertShape, number | undefined> = {
  C: 80, D: 55, V: 35, W: 80, T: 60, S: 90, R: undefined, E: 75,
  H: 120, O: 135, P: 108, L: 90, A: 85, B: 82, K: 55,
};

const regular = (sides: number): number[] => Array<number>(sides).fill((180 * (sides - 2)) / sides);

/** Interior angles of shapes with an incircle (IC is tangent to every side). */
const TANGENTIAL: Partial<Record<InsertShape, number[]>> = {
  C: [80, 100, 80, 100],
  D: [55, 125, 55, 125],
  V: [35, 145, 35, 145],
  E: [75, 105, 75, 105],
  W: [80, 160, 80, 160, 80, 160],
  T: regular(3),
  S: regular(4),
  P: regular(5),
  H: regular(6),
  O: regular(8),
};

const CORNER_DIRECTIONS: Record<Exclude<TurningActiveCorner, 'center'>, Point2> = {
  'front-right': [1, -1],
  'front-left': [-1, -1],
  'back-right': [1, 1],
  'back-left': [-1, 1],
};

const ARC_STEPS = 8;
const rad = (degrees: number): number => (degrees * Math.PI) / 180;

export function getInsertTipAngle(shape: InsertShape): number | undefined {
  return TIP_ANGLES[shape];
}

// Consecutive vertex directions differ by 180 - (a1 + a2) / 2; each vertex lies at apothem / sin(a / 2).
function tangentialPolygon(apothem: number, angles: number[]): Point2[] {
  let phi = -90;
  return angles.map((angle, index) => {
    const radius = apothem / Math.sin(rad(angle / 2));
    const point: Point2 = [radius * Math.cos(rad(phi)), radius * Math.sin(rad(phi))];
    phi += 180 - (angle + angles[(index + 1) % angles.length]) / 2;
    return point;
  });
}

function parallelogram(tipAngle: number, length: number, width: number): Point2[] {
  const dx = width * Math.cos(rad(tipAngle));
  const dy = width * Math.sin(rad(tipAngle));
  const points: Point2[] = [[0, 0], [length, 0], [length + dx, dy], [dx, dy]];
  const cx = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const cy = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  return points.map(([x, y]) => [x - cx, y - cy]);
}

function circle(radius: number): Point2[] {
  return Array.from({ length: 32 }, (_, index): Point2 => {
    const phi = rad(-90 + (index * 360) / 32);
    return [radius * Math.cos(phi), radius * Math.sin(phi)];
  });
}

// Rotates the outline so vertex 0 points to -Y (front, toward the tool tip).
function alignTipToFront(points: Point2[]): Point2[] {
  const vertex = points[0];
  const unit = (to: Point2): Point2 => {
    const dx = to[0] - vertex[0];
    const dy = to[1] - vertex[1];
    const length = Math.hypot(dx, dy) || 1;
    return [dx / length, dy / length];
  };
  const a = unit(points[1]);
  const b = unit(points[points.length - 1]);
  const turn = -Math.PI / 2 - Math.atan2(-(a[1] + b[1]), -(a[0] + b[0]));
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  return points.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
}

/** Sharp ISO outline centred on the incircle/centroid; vertex 0 is the working corner pointing to -Y. */
export function getInsertOutline(
  shape: InsertShape,
  radius: number,
  dimensions: { width?: number; length?: number } = {},
): Point2[] {
  const apothem = Math.max(0.1, radius);
  const angles = TANGENTIAL[shape];
  if (shape === 'R') return circle(apothem);
  if (angles) return alignTipToFront(tangentialPolygon(apothem, angles));
  const length = dimensions.length ?? 2 * apothem;
  const width = dimensions.width ?? 0.6 * length;
  return alignTipToFront(parallelogram(TIP_ANGLES[shape] ?? 90, length, width));
}

export function resolveZeroVertex(
  outline: Point2[],
  zeroVertex?: number,
  corner?: TurningActiveCorner,
): number | undefined {
  if (zeroVertex !== undefined) return zeroVertex < outline.length ? zeroVertex : 0;
  if (corner === 'center') return undefined;
  if (!corner) return 0;
  const [dx, dy] = CORNER_DIRECTIONS[corner];
  let best = 0;
  let bestScore = -Infinity;
  outline.forEach(([x, y], index) => {
    const score = x * dx + y * dy;
    if (score > bestScore + 1e-9) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}

function filletVertex(points: Point2[], index: number, radius: number): { points: Point2[]; centre: Point2 } {
  const count = points.length;
  const vertex = points[index];
  if (radius <= 1e-6) return { points, centre: vertex };
  const toNeighbour = (neighbour: Point2): { unit: Point2; length: number } => {
    const dx = neighbour[0] - vertex[0];
    const dy = neighbour[1] - vertex[1];
    const length = Math.hypot(dx, dy) || 1;
    return { unit: [dx / length, dy / length], length };
  };
  const first = toNeighbour(points[(index + count - 1) % count]);
  const second = toNeighbour(points[(index + 1) % count]);
  const alpha = Math.acos(Math.max(-1, Math.min(1, first.unit[0] * second.unit[0] + first.unit[1] * second.unit[1])));
  if (alpha < 1e-3 || alpha > Math.PI - 1e-3) return { points, centre: vertex };
  // Tangent length must leave half of each adjacent edge untouched.
  const tangent = Math.min(radius / Math.tan(alpha / 2), 0.5 * Math.min(first.length, second.length));
  const effective = tangent * Math.tan(alpha / 2);
  const t1: Point2 = [vertex[0] + first.unit[0] * tangent, vertex[1] + first.unit[1] * tangent];
  const t2: Point2 = [vertex[0] + second.unit[0] * tangent, vertex[1] + second.unit[1] * tangent];
  const bx = first.unit[0] + second.unit[0];
  const by = first.unit[1] + second.unit[1];
  const bl = Math.hypot(bx, by) || 1;
  const distance = effective / Math.sin(alpha / 2);
  const centre: Point2 = [vertex[0] + (bx / bl) * distance, vertex[1] + (by / bl) * distance];
  const a0 = Math.atan2(t1[1] - centre[1], t1[0] - centre[0]);
  let delta = Math.atan2(t2[1] - centre[1], t2[0] - centre[0]) - a0;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const arc = Array.from({ length: ARC_STEPS + 1 }, (_, step): Point2 => {
    const phi = a0 + (delta * step) / ARC_STEPS;
    return [centre[0] + effective * Math.cos(phi), centre[1] + effective * Math.sin(phi)];
  });
  return { points: [...points.slice(0, index), ...arc, ...points.slice(index + 1)], centre };
}

export function buildInsertContour(spec: InsertContourSpec, corner?: TurningActiveCorner): InsertContour {
  const outline = getInsertOutline(spec.shape, spec.ic / 2, spec);
  const zeroIndex = resolveZeroVertex(outline, spec.zeroVertex, corner);
  const origin: Point2 = zeroIndex === undefined ? [0, 0] : outline[zeroIndex];
  const sharp = outline.map(([x, y]): Point2 => [x - origin[0], y - origin[1]]);
  const rounded = spec.shape !== 'R' && zeroIndex !== undefined;
  if (!rounded) return { sharp, contour: sharp, zeroIndex };
  const filleted = filletVertex(sharp, zeroIndex, spec.noseRadius);
  return { sharp, contour: filleted.points, zeroIndex, radiusCenter: filleted.centre };
}
