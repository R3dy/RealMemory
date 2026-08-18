import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural anatomical brain — no external model files.
 *
 * Generates a two-hemisphere cerebrum (with longitudinal fissure, flattened
 * underside, temporal-lobe bulges and ridged-noise gyri/sulci folds), a finely
 * folded cerebellum at the lower-rear, and a tapered curved brain stem.
 * Everything is deterministic (seeded simplex noise) and shares the anatomy
 * constants below with `src/lib/brain-layout.ts` so memory nodes are contained
 * by the same volume the shell renders.
 */

// ---------------------------------------------------------------------------
// Shared anatomy constants (single source of truth for shell + layout)
// ---------------------------------------------------------------------------

export const CEREBRUM = {
  lobeX: 3.45, // hemisphere center |x|
  cy: 0.3, // hemisphere center y
  rx: 3.1, // lateral radius (per hemisphere)
  ry: 4.05, // vertical radius
  rz: 3.45, // front-back radius (+z = frontal pole)
  fissureHalf: 0.35, // half-width of the longitudinal fissure gap
} as const;

export const CEREBELLUM = {
  cx: 0,
  cy: -2.75,
  cz: -2.35,
  rx: 2.25,
  ry: 1.2,
  rz: 1.5,
} as const;

// ---------------------------------------------------------------------------
// Seeded 3D simplex noise (Gustavson), deterministic
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
] as const;

export class SimplexNoise {
  private perm: Uint8Array;
  private permMod12: Uint8Array;

  constructor(seed = 0x5eed) {
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  noise3(xin: number, yin: number, zin: number): number {
    const F3 = 1 / 3;
    const G3 = 1 / 6;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);

    let i1: number, j1: number, k1: number;
    let i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }

    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;

    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = GRAD3[this.permMod12[ii + this.perm[jj + this.perm[kk]]]];
      t0 *= t0;
      n += t0 * t0 * (g[0] * x0 + g[1] * y0 + g[2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = GRAD3[this.permMod12[ii + i1 + this.perm[jj + j1 + this.perm[kk + k1]]]];
      t1 *= t1;
      n += t1 * t1 * (g[0] * x1 + g[1] * y1 + g[2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = GRAD3[this.permMod12[ii + i2 + this.perm[jj + j2 + this.perm[kk + k2]]]];
      t2 *= t2;
      n += t2 * t2 * (g[0] * x2 + g[1] * y2 + g[2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = GRAD3[this.permMod12[ii + 1 + this.perm[jj + 1 + this.perm[kk + 1]]]];
      t3 *= t3;
      n += t3 * t3 * (g[0] * x3 + g[1] * y3 + g[2] * z3);
    }
    return 32 * n; // ~[-1, 1]
  }
}

// ---------------------------------------------------------------------------
// Cerebrum shaping — shared with the layout containment
// ---------------------------------------------------------------------------

/** Flattened underside factor: ventral surface is compressed (brain base). */
export function cerebrumRySign(localY: number): number {
  // top keeps full radius, bottom flattens to ~52%
  return localY >= 0 ? CEREBRUM.ry : CEREBRUM.ry * 0.52;
}

/**
 * Cortical fold displacement (gyri/sulci) for a point on the hemisphere.
 * `dir` is the unit-sphere direction, `p` the shaped (pre-fold) local point.
 * Domain-warped ridged simplex gives winding gyri with carved sulci.
 */
const foldNoise = new SimplexNoise(0xf01d5);

function foldDisplacement(dir: THREE.Vector3, p: THREE.Vector3): number {
  const f1 = 0.85;
  // domain warp vector (low frequency)
  const wx = foldNoise.noise3(p.x * f1 + 5.2, p.y * f1 + 1.3, p.z * f1 + 2.8);
  const wy = foldNoise.noise3(p.x * f1 + 9.1, p.y * f1 + 4.7, p.z * f1 + 0.6);
  const wz = foldNoise.noise3(p.x * f1 + 2.4, p.y * f1 + 8.9, p.z * f1 + 6.3);
  // primary ridged folds (warped)
  const g1 = 1 - Math.abs(foldNoise.noise3(p.x * 1.35 + 1.25 * wx, p.y * 1.35 + 1.25 * wy, p.z * 1.35 + 1.25 * wz));
  // secondary finer folds
  const g2 = 1 - Math.abs(foldNoise.noise3(p.x * 3.1 + 0.7 * wy, p.y * 3.1 + 0.7 * wz, p.z * 3.1 + 0.7 * wx));
  // tertiary texture
  const g3 = foldNoise.noise3(p.x * 6.5, p.y * 6.5, p.z * 6.5);
  // fade folds on the medial wall so the fissure stays a clean slot
  const medial = Math.max(0, -Math.sign(p.x) * dir.x); // 1 at the fissure wall
  const medialFade = 1 - 0.55 * medial * medial;
  return ((g1 - 0.58) * 0.52 + (g2 - 0.6) * 0.2 + g3 * 0.06) * medialFade;
}

/**
 * Shape one hemisphere: unit-sphere direction → displaced local point
 * (hemisphere centered at origin; caller translates by ±lobeX, cy).
 * `sign` = -1 left hemisphere, +1 right.
 */
export function shapeHemisphere(dir: THREE.Vector3, sign: number, folds: number): THREE.Vector3 {
  // base ellipsoid with flattened underside
  const p = new THREE.Vector3(
    dir.x * CEREBRUM.rx,
    dir.y * cerebrumRySign(dir.y),
    dir.z * CEREBRUM.rz,
  );

  // occipital (rear) taper — slightly narrower toward the back pole
  const rear = Math.max(0, -dir.z);
  p.x *= 1 - 0.14 * rear * rear;
  // frontal pole pushes slightly forward and fuller
  const front = Math.max(0, dir.z);
  p.z += 0.3 * front * front;

  // temporal lobe bulge: lower-front-lateral region
  const tx = sign * 0.68;
  const ty = -0.42;
  const tz = 0.45;
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
  const dot = (dir.x * tx + dir.y * ty + dir.z * tz) / tl;
  const bulge = Math.max(0, dot);
  p.addScaledVector(dir, 0.62 * bulge * bulge * bulge);

  // medial wall clamp → flat inner wall + clean longitudinal fissure slot
  const medialWall = CEREBRUM.rx * 0.86; // |local x| of the flat medial plane
  if (-sign * p.x > medialWall) p.x = -sign * medialWall;

  // gyri / sulci folds along the radial direction
  if (folds > 0) {
    p.addScaledVector(dir, foldDisplacement(dir, p) * folds);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------

function buildHemisphere(sign: number): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 24);
  geo = mergeVertices(geo, 1e-4); // indexed → smooth normals after displacement
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const dir = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    dir.fromBufferAttribute(pos, i).normalize();
    const p = shapeHemisphere(dir, sign, 1);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  geo.computeVertexNormals();
  geo.translate(sign * CEREBRUM.lobeX, CEREBRUM.cy, 0);
  return geo;
}

function buildCerebellum(): THREE.BufferGeometry {
  const noise = new SimplexNoise(0xcebe11);
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 20);
  geo = mergeVertices(geo, 1e-4);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const dir = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    dir.fromBufferAttribute(pos, i).normalize();
    const p = new THREE.Vector3(
      dir.x * CEREBELLUM.rx,
      dir.y * CEREBELLUM.ry * (dir.y > 0 ? 1 : 0.8),
      dir.z * CEREBELLUM.rz,
    );
    // fine horizontal folia ridges
    const wobble = noise.noise3(p.x * 1.4, p.y * 1.4, p.z * 1.4);
    const folia = Math.sin(p.y * 21 + 1.6 * wobble) * 0.085;
    const grain = (1 - Math.abs(noise.noise3(p.x * 5.5, p.y * 5.5, p.z * 5.5)) - 0.6) * 0.1;
    p.addScaledVector(dir, folia + grain);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  geo.computeVertexNormals();
  geo.translate(CEREBELLUM.cx, CEREBELLUM.cy, CEREBELLUM.cz);
  return geo;
}

function buildBrainStem(): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -1.9, -0.75),
    new THREE.Vector3(0, -2.9, -0.45),
    new THREE.Vector3(0, -3.9, 0.05),
    new THREE.Vector3(0, -4.9, 0.45),
  ]);
  const tubular = 28;
  const radial = 12;
  const geo = new THREE.TubeGeometry(curve, tubular, 0.52, radial, false);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const c = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular;
    curve.getPointAt(t, c);
    // tapered: pons bulge near top, narrowing down the medulla
    const taper = 1 - 0.48 * t + 0.22 * Math.sin(Math.min(1, t * 2.2) * Math.PI);
    for (let j = 0; j <= radial; j++) {
      const idx = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, idx).sub(c).multiplyScalar(taper).add(c);
      pos.setXYZ(idx, v.x, v.y, v.z);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

export interface BrainGeometries {
  left: THREE.BufferGeometry;
  right: THREE.BufferGeometry;
  cerebellum: THREE.BufferGeometry;
  stem: THREE.BufferGeometry;
}

let cached: BrainGeometries | null = null;

/** Deterministic, memoized — built once for the session. */
export function getBrainGeometries(): BrainGeometries {
  if (!cached) {
    cached = {
      left: buildHemisphere(-1),
      right: buildHemisphere(1),
      cerebellum: buildCerebellum(),
      stem: buildBrainStem(),
    };
  }
  return cached;
}
