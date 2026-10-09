export interface TraceNode {
  x: number;
  y: number;
  z: number;
  span: number;
  state: 'solid' | 'empty' | 'branch' | 'boundary' | 'pristine';
  occupied: number;
  data?: Float64Array;
  normals?: Float32Array;
  normalMask?: number;
  edgeMask?: number;
  children?: TraceNode[];
}

const STATES = ['solid', 'empty', 'branch', 'boundary', 'pristine'] as const;
const MAGIC = 0x53545231;
const HEADER = 40;
const ROW = 24;

/** Binary fields preserve every Float64 root and Float32 normal, including NaN masks. */
export function encodeStockRegion(root: TraceNode, reserve: (bytes: number) => void): Uint8Array {
  const nodes: TraceNode[] = [];
  const fields = new Map<Float64Array, number>();
  const normals = new Map<Float32Array, number>();
  let bytes = HEADER;
  const visit = (node: TraceNode): void => {
    reserve(bytes + nodes.length * 96 + (fields.size + normals.size) * 128 + ROW);
    nodes.push(node);
    bytes += ROW;
    if (node.data && !fields.has(node.data)) {
      fields.set(node.data, fields.size);
      bytes += 4 + node.data.byteLength;
    }
    if (node.normals && !normals.has(node.normals)) {
      normals.set(node.normals, normals.size);
      bytes += 4 + node.normals.byteLength;
    }
    node.children?.forEach(visit);
  };
  visit(root);
  reserve(bytes + nodes.length * 96 + (fields.size + normals.size) * 128);
  const output = new Uint8Array(bytes);
  const view = new DataView(output.buffer);
  [MAGIC, 1, root.x, root.y, root.z, root.span, nodes.length, fields.size, normals.size, 0].forEach(
    (value, index) => view.setUint32(index * 4, value, true),
  );
  let offset = HEADER;
  for (const node of nodes) {
    view.setUint8(offset, STATES.indexOf(node.state));
    view.setUint16(offset + 1, node.normalMask ?? 0xffff, true);
    view.setUint16(offset + 3, node.edgeMask ?? 0xffff, true);
    view.setFloat64(offset + 8, node.occupied, true);
    view.setUint32(offset + 16, node.data ? fields.get(node.data)! : 0xffffffff, true);
    view.setUint32(offset + 20, node.normals ? normals.get(node.normals)! : 0xffffffff, true);
    offset += ROW;
  }
  for (const pool of [fields, normals]) {
    for (const [data] of pool) {
      view.setUint32(offset, data.length, true);
      offset += 4;
      output.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
      offset += data.byteLength;
    }
  }
  return output;
}

export function decodeStockRegion(data: Uint8Array): TraceNode {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < HEADER || view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== 1)
    throw new Error('Invalid stock region history header');
  const count = view.getUint32(24, true);
  if (!count || HEADER + count * ROW > data.length)
    throw new Error('Invalid stock history node count');
  const fields: Float64Array[] = [],
    normals: Float32Array[] = [];
  let offset = HEADER + count * ROW;
  const readPool = <T extends Float64Array | Float32Array>(
    n: number,
    size: number,
    make: (buffer: ArrayBuffer) => T,
    pool: T[],
  ): void => {
    if (n > count) throw new Error('Invalid stock history field count');
    for (let i = 0; i < n; i++) {
      if (offset + 4 > data.length) throw new Error('Truncated stock history field');
      const length = view.getUint32(offset, true);
      offset += 4;
      if (length > 36 || offset + length * size > data.length)
        throw new Error('Invalid stock history field length');
      pool.push(make(data.slice(offset, offset + length * size).buffer));
      offset += length * size;
    }
  };
  readPool(view.getUint32(28, true), 8, (buffer) => new Float64Array(buffer), fields);
  readPool(view.getUint32(32, true), 4, (buffer) => new Float32Array(buffer), normals);
  if (offset !== data.length) throw new Error('Unexpected stock history trailing bytes');
  let index = 0;
  const readNode = (x: number, y: number, z: number, span: number): TraceNode => {
    if (index >= count || !Number.isSafeInteger(span) || span < 1 || span & (span - 1))
      throw new Error('Invalid stock history topology');
    const row = HEADER + index++ * ROW;
    const state = STATES[view.getUint8(row)];
    const occupied = view.getFloat64(row + 8, true);
    const field = view.getUint32(row + 16, true),
      normal = view.getUint32(row + 20, true);
    if (
      !state ||
      !Number.isSafeInteger(occupied) ||
      occupied < 0 ||
      occupied > span ** 3 ||
      (field !== 0xffffffff && field >= fields.length) ||
      (normal !== 0xffffffff && normal >= normals.length)
    )
      throw new Error('Invalid stock history node');
    const normalMask = view.getUint16(row + 1, true),
      edgeMask = view.getUint16(row + 3, true);
    const node: TraceNode = {
      x,
      y,
      z,
      span,
      state,
      occupied,
      data: fields[field],
      normals: normals[normal],
      normalMask: normalMask === 0xffff ? undefined : normalMask,
      edgeMask: edgeMask === 0xffff ? undefined : edgeMask,
    };
    if (state === 'branch') {
      if (span === 1) throw new Error('Invalid stock history branch');
      const half = span / 2;
      node.children = Array.from({ length: 8 }, (_, child) =>
        readNode(
          x + (child & 1) * half,
          y + ((child >> 1) & 1) * half,
          z + ((child >> 2) & 1) * half,
          half,
        ),
      );
      if (node.children.reduce((sum, child) => sum + child.occupied, 0) !== occupied)
        throw new Error('Inconsistent stock history occupancy');
    }
    return node;
  };
  const root = readNode(
    view.getUint32(8, true),
    view.getUint32(12, true),
    view.getUint32(16, true),
    view.getUint32(20, true),
  );
  if (index !== count) throw new Error('Inconsistent stock history tree');
  return root;
}
