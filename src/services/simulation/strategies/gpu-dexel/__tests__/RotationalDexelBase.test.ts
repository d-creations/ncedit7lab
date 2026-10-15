import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { RotationalProfile } from '../../cpu-hybrid/RotationalProfile';
import { turningSectionVolume } from '../../../shared/TurningEnvelope';
import { RotationalDexelBase } from '../RotationalDexelBase';
import { RevolvedStock } from '../RevolvedStock';

function remove(profile: RotationalProfile, points: [number, number][]) {
  profile.apply(
    turningSectionVolume(
      points.map((p) => new THREE.Vector2(...p)),
      new THREE.Vector3(),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 0),
    ),
    () => {},
  );
}
function rectangle(profile: RotationalProfile, lo: number, hi: number, a: number, b: number) {
  remove(profile, [
    [lo, a],
    [hi, a],
    [hi, b],
    [lo, b],
  ]);
}

describe('immutable analytical rotational dexel base', () => {
  it('bounds asymmetric work by the remaining turned material without dropping tapers or annuli', () => {
    const profile = new RotationalProfile(10, 50);
    rectangle(profile, 3, 11, -20, 20);
    rectangle(profile, 0, 1, -25, 25);
    rectangle(profile, 0, 11, 4, 5);
    const base = new RotationalDexelBase(profile);
    const cutter = new THREE.Box3(new THREE.Vector3(2, -9, -10), new THREE.Vector3(9, 9, 10));
    const bounds = base.materialBounds(cutter);
    expect(bounds.min.x).toBe(2);
    expect(bounds.max.x).toBeLessThan(3.001);
    expect(bounds.min.y).toBeGreaterThan(-3.001);
    expect(bounds.max.y).toBeLessThan(3.001);
    expect(
      base
        .materialBounds(new THREE.Box3(new THREE.Vector3(4, -1, -10), new THREE.Vector3(9, 1, 10)))
        .isEmpty(),
    ).toBe(true);
    expect(
      base
        .materialBounds(
          new THREE.Box3(new THREE.Vector3(-1, -1, 4.1), new THREE.Vector3(1, 1, 4.9)),
        )
        .isEmpty(),
    ).toBe(true);
    for (let z = -24.7; z < 25; z += 0.73)
      for (let x = 0.17; x < 10; x += 0.31) {
        const point = new THREE.Vector3(x, 0.2, z);
        if (!cutter.containsPoint(point) || profile.volume.distance(point) >= -1e-6) continue;
        expect(bounds.containsPoint(point)).toBe(true);
      }
  });

  it('matches the full material field along all axes through cones, bores, annuli and cutoff gaps', () => {
    const profile = new RotationalProfile(10, 50);
    rectangle(profile, 0, 1.1, -25, 25);
    rectangle(profile, 2.3, 3.7, -17, 13);
    rectangle(profile, -11, 11, -0.4, 0.4);
    remove(profile, [
      [6, -24],
      [11, -24],
      [11, 24],
      [8, 24],
    ]);
    const base = new RotationalDexelBase(profile);
    let tested = 0;
    for (const axis of [0, 1, 2])
      for (let z = -24.73; z < 25; z += 1.91)
        for (let x = -9.83; x < 10; x += 0.89)
          for (const y of [-8.21, -3.17, 0.13, 1.73, 5.67]) {
            const point = new THREE.Vector3(x, y, z);
            const expected = profile.volume.distance(point);
            if (Math.abs(expected) < 1e-7) continue;
            const intervals = base.intervals(axis, point);
            expect(
              intervals.some(
                ([a, b]) => point.getComponent(axis) > a && point.getComponent(axis) < b,
              ),
            ).toBe(expected < 0);
            tested++;
          }
    expect(tested).toBeGreaterThan(8000);
    const key = base.fingerprint;
    rectangle(profile, 0, 11, 4, 5);
    expect(base.fingerprint).toBe(key);
    expect(
      base.intervals(2, new THREE.Vector3(5, 0, 4.5)).some(([a, b]) => a < 4.5 && b > 4.5),
    ).toBe(true);
    expect(new RotationalDexelBase(profile).fingerprint).not.toBe(key);
  });

  it('does not classify an adjacent-double subdivision as original full-radius stock', () => {
    const profile = new RotationalProfile(2, 6);
    rectangle(profile, 1, 3, -2, 1 + Number.EPSILON);
    rectangle(profile, 1, 3, 1, 2);
    expect(
      profile.meridianSlabs
        .filter((s) => s.lower >= -2 && s.upper <= 2)
        .every((s) => s.intervals.every((band) => band.upper.offset <= 1)),
    ).toBe(true);
    const stock = new RevolvedStock(profile, 0.02, new THREE.Matrix4(), () => {});
    const geometry = (stock.group.children[0] as THREE.Mesh).geometry;
    const p = geometry.getAttribute('position'),
      n = geometry.getAttribute('normal');
    const edges = new Map<string, { count: number; balance: number }>();
    for (let i = 0; i < p.count; i += 3) {
      const vertices = [0, 1, 2].map((j) => new THREE.Vector3().fromBufferAttribute(p, i + j));
      const cross = vertices[1]
        .clone()
        .sub(vertices[0])
        .cross(vertices[2].clone().sub(vertices[0]));
      expect(cross.lengthSq()).toBeGreaterThan(0);
      expect(cross.normalize().dot(new THREE.Vector3().fromBufferAttribute(n, i))).toBeGreaterThan(
        0.95,
      );
      for (let j = 0; j < 3; j++) {
        const a = vertices[j].toArray().join(','),
          b = vertices[(j + 1) % 3].toArray().join(',');
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const edge = edges.get(key) ?? { count: 0, balance: 0 };
        edge.count++;
        edge.balance += a < b ? 1 : -1;
        edges.set(key, edge);
      }
    }
    expect([...edges.values()].every((edge) => edge.count === 2 && edge.balance === 0)).toBe(true);
    // No caps inside the continuous turned section, but true end shoulders remain.
    let shoulders = 0;
    for (let i = 0; i < p.count; i += 3) {
      if (p.getZ(i) !== p.getZ(i + 1) || p.getZ(i) !== p.getZ(i + 2)) continue;
      const z = p.getZ(i);
      expect(z > -2 && z < 2).toBe(false);
      if (z === -2 || z === 2) shoulders++;
      const a = new THREE.Vector3().fromBufferAttribute(p, i);
      const b = new THREE.Vector3().fromBufferAttribute(p, i + 1);
      const c = new THREE.Vector3().fromBufferAttribute(p, i + 2);
      const cross = b.sub(a).cross(c.sub(a)).normalize();
      expect(cross.dot(new THREE.Vector3().fromBufferAttribute(n, i))).toBeGreaterThan(0.99);
    }
    expect(shoulders).toBeGreaterThan(0);
    stock.dispose();
  });

  it('retains a genuinely thin 0.01 mm shoulder rather than hiding physical discs', () => {
    const profile = new RotationalProfile(2, 6);
    rectangle(profile, 1, 3, -2, 0);
    rectangle(profile, 1, 3, 0.01, 2);
    const base = new RotationalDexelBase(profile);
    expect(base.intervals(2, new THREE.Vector3(1.5, 0, 0))).toEqual([
      [-3, -2],
      [0, 0.01],
      [2, 3],
    ]);
  });
});
