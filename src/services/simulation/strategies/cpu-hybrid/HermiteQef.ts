import * as THREE from 'three';

export interface HermiteSample {
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

function solve(matrix: number[][], right: number[]): number[] {
  const rows = matrix.map((row, i) => [...row, right[i]]);
  for (let column = 0; column < rows.length; column++) {
    let pivot = column;
    for (let row = column + 1; row < rows.length; row++)
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    if (Math.abs(rows[column][column]) < 1e-14)
      throw new Error('Singular regularized Hermite system');
    const divisor = rows[column][column];
    for (let j = column; j <= rows.length; j++) rows[column][j] /= divisor;
    for (let row = 0; row < rows.length; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let j = column; j <= rows.length; j++) rows[row][j] -= factor * rows[column][j];
    }
  }
  return rows.map((row) => row[rows.length]);
}

/** Mass-point regularization handles planar/rank-deficient samples; active sets bound vertices. */
export function boundedQef(samples: readonly HermiteSample[], bounds: THREE.Box3): THREE.Vector3 {
  if (!samples.length) throw new Error('Hermite reconstruction requires surface samples');
  if (
    bounds.isEmpty() ||
    ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite) ||
    samples.some(
      (sample) =>
        !sample.point.toArray().every(Number.isFinite) ||
        !Number.isFinite(sample.normal.lengthSq()) ||
        Math.abs(sample.normal.lengthSq() - 1) > 1e-5,
    )
  )
    throw new Error('Hermite reconstruction requires finite points, unit normals and valid bounds');
  const mass = samples
    .reduce((sum, sample) => sum.add(sample.point), new THREE.Vector3())
    .divideScalar(samples.length);
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0]);
  const right = [0, 0, 0];
  const regularization = samples.length * 1e-8;
  for (const sample of samples) {
    const normal = sample.normal.toArray();
    const offset = sample.normal.dot(sample.point.clone().sub(mass));
    for (let i = 0; i < 3; i++) {
      right[i] += normal[i] * offset;
      for (let j = 0; j < 3; j++) matrix[i][j] += normal[i] * normal[j];
    }
  }
  for (let i = 0; i < 3; i++) matrix[i][i] += regularization;
  const low = bounds.min.clone().sub(mass).toArray();
  const high = bounds.max.clone().sub(mass).toArray();
  const candidate = (states: readonly number[]): number[] => {
    const free = [0, 1, 2].filter((i) => states[i] === 0 && low[i] !== high[i]);
    const result = states.map((state, i) =>
      state < 0 || low[i] === high[i] ? low[i] : state > 0 ? high[i] : 0,
    );
    const values = solve(
      free.map((i) => free.map((j) => matrix[i][j])),
      free.map(
        (i) =>
          right[i] -
          matrix[i].reduce((sum, value, j) => sum + (free.includes(j) ? 0 : value * result[j]), 0),
      ),
    );
    free.forEach((axis, i) => {
      result[axis] = values[i];
    });
    return result;
  };
  const inBounds = (point: readonly number[]): boolean =>
    point.every(
      (value, i) => Number.isFinite(value) && value >= low[i] - 1e-12 && value <= high[i] + 1e-12,
    );
  const first = candidate([0, 0, 0]);
  if (inBounds(first)) return new THREE.Vector3(...first).add(mass).clamp(bounds.min, bounds.max);
  let best: number[] | undefined,
    error = Infinity;
  for (const x of [-1, 0, 1])
    for (const y of [-1, 0, 1])
      for (const z of [-1, 0, 1]) {
        const point = candidate([x, y, z]);
        if (!inBounds(point)) continue;
        const value = new THREE.Vector3(...point).add(mass);
        const residual =
          samples.reduce(
            (sum, sample) => sum + sample.normal.dot(value.clone().sub(sample.point)) ** 2,
            0,
          ) +
          regularization * point.reduce((sum, coordinate) => sum + coordinate ** 2, 0);
        if (residual < error) {
          best = point;
          error = residual;
        }
      }
  if (!best) throw new Error('Hermite vertex has no finite bounded solution');
  return new THREE.Vector3(...best).add(mass).clamp(bounds.min, bounds.max);
}
