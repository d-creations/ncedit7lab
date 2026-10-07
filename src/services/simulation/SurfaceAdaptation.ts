import * as THREE from 'three';

type Interval = readonly [number, number];
type Triangle = readonly [number, number, number];
type Bounds = readonly [number, number, number, number, number, number];

interface Vertex {
  point: number[];
  normal: THREE.Vector3;
  source: number;
  triangles: number[];
  locked: boolean;
}

interface Tree {
  bounds: Bounds;
  children?: readonly [Tree, Tree];
  triangles?: number[];
}

const rounding = new DataView(new ArrayBuffer(8));
function next(value: number, up: boolean): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  rounding.setFloat64(0, value);
  const bits = rounding.getBigUint64(0);
  rounding.setBigUint64(0, bits + (value > 0 === up ? 1n : -1n));
  return rounding.getFloat64(0);
}
const exact = (value: number): Interval => [value, value];
const add = (a: Interval, b: Interval): Interval => [
  next(a[0] + b[0], false),
  next(a[1] + b[1], true),
];
const sub = (a: Interval, b: Interval): Interval => [
  next(a[0] - b[1], false),
  next(a[1] - b[0], true),
];
function mul(a: Interval, b: Interval): Interval {
  const values = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return [next(Math.min(...values), false), next(Math.max(...values), true)];
}
function div(a: Interval, b: Interval): Interval {
  if (b[0] <= 0 && b[1] >= 0) return [-Infinity, Infinity];
  return mul(a, [next(1 / b[1], false), next(1 / b[0], true)]);
}

function orientation(a: number[], b: number[], c: number[], u: number, v: number): Interval {
  if ((a[u] === c[u] && a[v] === c[v]) || (b[u] === c[u] && b[v] === c[v])) return [0, 0];
  return sub(
    mul(sub(exact(b[u]), exact(a[u])), sub(exact(c[v]), exact(a[v]))),
    mul(sub(exact(b[v]), exact(a[v])), sub(exact(c[u]), exact(a[u]))),
  );
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return [0, 1, 2].every((axis) => a[axis] <= b[axis + 3] && b[axis] <= a[axis + 3]);
}

function boundsOf(ids: readonly number[], vertices: readonly Vertex[]): Bounds {
  return [
    ...[0, 1, 2].map((axis) => Math.min(...ids.map((id) => vertices[id].point[axis]))),
    ...[0, 1, 2].map((axis) => Math.max(...ids.map((id) => vertices[id].point[axis]))),
  ] as unknown as Bounds;
}

function treeOf(ids: number[], boxes: readonly Bounds[]): Tree {
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const id of ids)
    for (let axis = 0; axis < 3; axis++) {
      bounds[axis] = Math.min(bounds[axis], boxes[id][axis]);
      bounds[axis + 3] = Math.max(bounds[axis + 3], boxes[id][axis + 3]);
    }
  if (ids.length <= 12) return { bounds: bounds as unknown as Bounds, triangles: ids };
  const spans = [0, 1, 2].map((axis) => bounds[axis + 3] - bounds[axis]);
  const axis = spans.indexOf(Math.max(...spans));
  ids.sort((a, b) => boxes[a][axis] + boxes[a][axis + 3] - boxes[b][axis] - boxes[b][axis + 3]);
  const half = Math.floor(ids.length / 2);
  return {
    bounds: bounds as unknown as Bounds,
    children: [treeOf(ids.slice(0, half), boxes), treeOf(ids.slice(half), boxes)],
  };
}

function query(tree: Tree, box: Bounds, visit: (id: number) => void): void {
  if (!overlaps(tree.bounds, box)) return;
  if (tree.triangles) for (const id of tree.triangles) visit(id);
  else for (const child of tree.children!) query(child, box, visit);
}

const edgeKey = (a: number, b: number): string => `${Math.min(a, b)}:${Math.max(a, b)}`;

/** Includes batch reservations for the disconnected-triangle worst case. */
export function surfaceAdaptationWorkspaceBound(triangles: number): number {
  return (
    triangles * 768 +
    32768 +
    Math.ceil((triangles * 3) / 64) * 64 * 768 +
    Math.ceil((triangles * 3) / 128) * 128 * 256
  );
}

/**
 * Returns source vertex offsets, not new coordinates. A single pass replaces disjoint
 * original manifold stars; it never simplifies an already simplified surface.
 * The error bound is against the input Float32 mesh, not the exact cutter/field.
 */
export function adaptSurface(
  positions: Float32Array,
  normals: Float32Array,
  eligible: Uint8Array,
  tolerance: number,
  accountWorkspace: (bytes: number) => void,
  chunkBounds?: THREE.Box3,
): number[] | undefined {
  const count = positions.length / 9;
  if (!tolerance || !count || !eligible.some((value) => value !== 0)) return undefined;
  // Triangle storage, adjacency entries, BVH, result and sorting arrays have
  // linear bounds. Charge welded vertices and unique edge Maps separately:
  // regular manifold surfaces share them, unlike the 3-per-triangle worst case.
  const baseWorkspace = count * 768 + 32768;
  let reservedVertices = 0,
    reservedEdges = 0;
  const account = (): void =>
    accountWorkspace(baseWorkspace + reservedVertices * 768 + reservedEdges * 256);
  account();
  const vertices: Vertex[] = [];
  const welded = new Map<string, number>();
  const triangles: Triangle[] = [];
  const edges = new Map<string, { count: number; balance: number }>();
  const weights = [0, 0, 0];
  for (let t = 0; t < count; t++) {
    const ids: number[] = [];
    for (let corner = 0; corner < 3; corner++) {
      const source = t * 9 + corner * 3;
      const point = Array.from(positions.subarray(source, source + 3));
      const key = point.join(',');
      const normal = new THREE.Vector3().fromArray(normals, source);
      let id = welded.get(key);
      if (id === undefined) {
        if (vertices.length === reservedVertices) {
          reservedVertices += 64;
          account();
        }
        id = vertices.length;
        welded.set(key, id);
        vertices.push({
          point,
          normal,
          source,
          triangles: [],
          locked:
            !point.every(Number.isFinite) ||
            !Number.isFinite(normal.lengthSq()) ||
            normal.lengthSq() < 0.5 ||
            (chunkBounds !== undefined &&
              point.some(
                (coordinate, axis) =>
                  coordinate === Math.fround(chunkBounds.min.getComponent(axis)) ||
                  coordinate === Math.fround(chunkBounds.max.getComponent(axis)),
              )),
        });
      }
      const vertex = vertices[id];
      if (!eligible[t] || vertex.normal.dot(normal) < 0.95) vertex.locked = true;
      vertex.triangles.push(t);
      ids.push(id);
    }
    const triangle = ids as unknown as Triangle;
    triangles.push(triangle);
    for (let i = 0; i < 3; i++) {
      const a = triangle[i],
        b = triangle[(i + 1) % 3];
      const key = edgeKey(a, b);
      let edge = edges.get(key);
      if (!edge) {
        if (edges.size === reservedEdges) {
          reservedEdges += 128;
          account();
        }
        edge = { count: 0, balance: 0 };
      }
      edge.count++;
      edge.balance += a < b ? 1 : -1;
      edges.set(key, edge);
    }
    if (eligible[t]) {
      const a = new THREE.Vector3(...vertices[triangle[0]].point);
      const b = new THREE.Vector3(...vertices[triangle[1]].point);
      const c = new THREE.Vector3(...vertices[triangle[2]].point);
      const normal = b.sub(a).cross(c.sub(a));
      for (let axis = 0; axis < 3; axis++) weights[axis] += Math.abs(normal.getComponent(axis));
    }
  }
  for (const [key, edge] of edges)
    if (edge.count !== 2 || edge.balance !== 0)
      for (const id of key.split(':').map(Number)) vertices[id].locked = true;
  if (!weights.every(Number.isFinite)) return undefined;

  // One chart axis per chunk also preserves every selected patch's projected
  // footprint during simultaneous replacement, including collision checks.
  const axis = weights.indexOf(Math.max(...weights));
  let u = (axis + 1) % 3,
    v = (axis + 2) % 3;
  const boxes = triangles.map((triangle) => boundsOf(triangle, vertices));
  const tree = treeOf(
    triangles.map((_, id) => id),
    boxes,
  );
  const removed = new Uint8Array(count);
  const replacements: Triangle[] = [];
  for (let centre = 0; centre < vertices.length; centre++) {
    const vertex = vertices[centre];
    const star = vertex.triangles;
    if (vertex.locked || star.length < 3 || star.length > 12) continue;
    if (star.some((id) => removed[id] || !eligible[id])) continue;
    const outgoing = new Map<number, number>();
    let valid = true;
    for (const id of star) {
      const triangle = triangles[id];
      const index = triangle.indexOf(centre);
      const a = triangle[(index + 1) % 3],
        b = triangle[(index + 2) % 3];
      if (a === b || a === centre || b === centre || outgoing.has(a)) valid = false;
      outgoing.set(a, b);
    }
    const ring = [outgoing.keys().next().value as number];
    while (valid && ring.length < star.length) {
      const id = outgoing.get(ring[ring.length - 1]);
      if (id === undefined || ring.includes(id)) valid = false;
      else ring.push(id);
    }
    if (!valid || outgoing.get(ring[ring.length - 1]) !== ring[0]) continue;
    if (ring.some((id) => vertices[id].locked)) continue;
    const reference = vertex.normal.clone().normalize();
    if (Math.abs(reference.getComponent(axis)) < 0.5) continue;
    if (reference.getComponent(axis) < 0) [u, v] = [(axis + 2) % 3, (axis + 1) % 3];
    else [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
    const points = [centre, ...ring].map((id) => vertices[id].point);
    if (ring.some((id) => vertices[id].normal.dot(reference) < 0.95)) continue;
    const box = boundsOf([centre, ...ring], vertices);
    const scale = Math.max(box[u + 3] - box[u], box[v + 3] - box[v]);
    const minimumArea = scale * scale * 1e-8;
    // Strict convexity and positive original triangles prove the same single
    // disk is covered by both fans, with no inverted ears or ambiguous folds.
    if (
      ring.some(
        (id, i) =>
          orientation(
            vertices[id].point,
            vertices[ring[(i + 1) % ring.length]].point,
            vertices[ring[(i + 2) % ring.length]].point,
            u,
            v,
          )[0] <= minimumArea,
      ) ||
      star.some((id) => {
        const triangle = triangles[id].map((index) => vertices[index].point);
        const normal = new THREE.Vector3(...triangle[1])
          .sub(new THREE.Vector3(...triangle[0]))
          .cross(new THREE.Vector3(...triangle[2]).sub(new THREE.Vector3(...triangle[0])))
          .normalize();
        return (
          normal.dot(reference) < 0.95 ||
          orientation(triangle[0], triangle[1], triangle[2], u, v)[0] <= minimumArea
        );
      })
    )
      continue;
    const replacement: Triangle[] = [];
    for (let i = 1; i < ring.length - 1; i++) replacement.push([ring[0], ring[i], ring[i + 1]]);
    if (
      replacement.some((triangle) =>
        triangle.some((a, i) => {
          const b = triangle[(i + 1) % 3];
          return edges.has(edgeKey(a, b)) && outgoing.get(a) !== b && outgoing.get(b) !== a;
        }),
      )
    )
      continue;
    // Each replacement plane is compared with ALL original star vertices,
    // including those outside its projected triangle. Affine residual extrema
    // on every old triangle occur at its vertices, giving a full height envelope
    // over the common projected disk (and hence a two-sided Hausdorff bound).
    // Outward-rounded intervals reject uncertain arithmetic instead of silently
    // accepting a sampled or numerically under-estimated deviation.
    const bounded = replacement.every((triangle) => {
      const [a, b, c] = triangle.map((id) => vertices[id].point);
      const bu = sub(exact(b[u]), exact(a[u])),
        bv = sub(exact(b[v]), exact(a[v])),
        cu = sub(exact(c[u]), exact(a[u])),
        cv = sub(exact(c[v]), exact(a[v]));
      const bh = sub(exact(b[axis]), exact(a[axis])),
        ch = sub(exact(c[axis]), exact(a[axis]));
      const determinant = sub(mul(bu, cv), mul(bv, cu));
      if (determinant[0] <= minimumArea) return false;
      const slopeU = div(sub(mul(bh, cv), mul(ch, bv)), determinant);
      const slopeV = div(sub(mul(bu, ch), mul(cu, bh)), determinant);
      return points.every((point) => {
        const residual = sub(
          sub(exact(point[axis]), exact(a[axis])),
          add(
            mul(slopeU, sub(exact(point[u]), exact(a[u]))),
            mul(slopeV, sub(exact(point[v]), exact(a[v]))),
          ),
        );
        return residual[0] >= -tolerance && residual[1] <= tolerance;
      });
    });
    if (!bounded) continue;
    const search = [...box];
    const clearance = mul(exact(2), exact(tolerance));
    search[axis] = sub(exact(box[axis]), clearance)[0];
    search[axis + 3] = add(exact(box[axis + 3]), clearance)[1];
    let isolated = true;
    const polygon = ring.map((id) => vertices[id].point);
    query(tree, search as unknown as Bounds, (id) => {
      if (!isolated || star.includes(id) || !overlaps(boxes[id], search as unknown as Bounds))
        return;
      const triangle = triangles[id].map((index) => vertices[index].point);
      const outside = (a: number[], b: number[], samples: number[][]): boolean =>
        samples.every((point) => orientation(a, b, point, u, v)[1] <= 0);
      if (polygon.some((a, i) => outside(a, polygon[(i + 1) % polygon.length], triangle))) return;
      const direction = orientation(triangle[0], triangle[1], triangle[2], u, v);
      if (direction[0] > 0 || direction[1] < 0) {
        if (direction[1] < 0) triangle.reverse();
        if (triangle.some((a, i) => outside(a, triangle[(i + 1) % 3], polygon))) return;
      }
      // Another sheet (including projection-degenerate vertical triangles)
      // could enter the patch's height prism. Keep the original fine star.
      isolated = false;
    });
    if (!isolated) continue;
    for (const id of star) removed[id] = 1;
    // Stars may share retained ring vertices, but never original triangles.
    // Removed centres cannot be reused, and no replacement is simplified again.
    vertex.locked = true;
    replacements.push(...replacement);
  }
  if (!replacements.length) return undefined;
  const result: number[] = [];
  for (let id = 0; id < count; id++) if (!removed[id]) result.push(id * 9, id * 9 + 3, id * 9 + 6);
  for (const triangle of replacements) for (const id of triangle) result.push(vertices[id].source);
  return result;
}
