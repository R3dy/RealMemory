import { forceSimulation, forceLink, forceManyBody } from 'd3-force-3d';
import { CEREBRUM, CEREBELLUM } from '@/components/brain/brain-mesh';
import type { GraphEdge, Memory } from './data';
import { BRAIN_REGIONS, UNASSIGNED_REGION_INDEX, computeDomainRegionMap, regionIndexFor } from './domain-regions';

/**
 * Anatomical brain-region layout.
 *
 * Each memory's `domain` maps to a brain region (frontal/parietal/temporal/
 * occipital lobe, cerebellum, or brain stem). Nodes seed near their region's
 * anchor point, then a d3-force-3d pass relaxes them while:
 *   - `forceRegion`   — weak pull toward the region anchor (keeps clusters distinct)
 *   - `forceLink`     — edges pull connected nodes together
 *   - `forceManyBody` — charge spreads nodes apart
 *   - `forceCerebrum` — containment: cerebrum nodes (regions 0-7) stay inside
 *                       their hemisphere volume (selected by `lobe` parity)
 *   - `forceCerebellum` — containment: cerebellum nodes (region 8) stay inside
 *                         the cerebellum ellipsoid
 *   - `forceStem`     — containment: stem nodes (region 9) stay near the stem curve
 *
 * Deterministic (fixed seed) so the brain is stable across renders.
 */

export type PositionMap = Map<string, [number, number, number]>;

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

// Interior containment volumes (inset from the shell surface / fold zone)
const LOBE_X = CEREBRUM.lobeX; // 3.45
const CY = CEREBRUM.cy; // 0.3
const RX_IN = CEREBRUM.rx * 0.76; // lateral — keeps |x| >= ~1.0 (out of the fissure)
const RY_TOP = CEREBRUM.ry * 0.76;
const RY_BOT = CEREBRUM.ry * 0.52 * 0.82; // flattened underside of the cerebrum
const RZ_IN = CEREBRUM.rz * 0.86; // deep front-back spread

// Cerebellum containment (matches CEREBELLUM constants in brain-mesh.ts)
const CB_CX = CEREBELLUM.cx;
const CB_CY = CEREBELLUM.cy;
const CB_CZ = CEREBELLUM.cz;
const CB_RX = CEREBELLUM.rx * 0.82;
const CB_RY = CEREBELLUM.ry * 0.82;
const CB_RZ = CEREBELLUM.rz * 0.82;

// Brain stem containment — thin cylinder around the stem curve (z≈0, y from -1.9 to -4.9)
const STEM_RADIUS = 0.45; // inside the tube radius (0.52) from brain-mesh.ts

interface SimNode {
  id: string;
  domain: string | undefined;
  regionIndex: number;
  lobe: number; // ±LOBE_X for cerebrum hemispheres, 0 for cerebellum/stem
  x: number;
  y: number;
  z: number;
}

/** Normalized cerebrum distance² for a point (≤1 = inside the interior volume). */
function cerebrumUnit2(x: number, y: number, z: number, lobe: number): number {
  const lx = (x - lobe) / RX_IN;
  const ly = (y - CY) / (y >= CY ? RY_TOP : RY_BOT);
  const lz = z / RZ_IN;
  return lx * lx + ly * ly + lz * lz;
}

/** Normalized cerebellum distance² (≤1 = inside). */
function cerebellumUnit2(x: number, y: number, z: number): number {
  const lx = (x - CB_CX) / CB_RX;
  const ly = (y - CB_CY) / CB_RY;
  const lz = (z - CB_CZ) / CB_RZ;
  return lx * lx + ly * ly + lz * lz;
}

/** Derive the hemisphere lobe from the region index (even→left, odd→right, 8-9→0). */
function lobeForRegion(ri: number): number {
  if (ri >= 8) return 0;
  return ri % 2 === 0 ? -LOBE_X : LOBE_X;
}

export function computeBrainLayout(nodes: Memory[], edges: GraphEdge[]): PositionMap {
  const rand = mulberry32(0xb3a12025);
  const regionMap = computeDomainRegionMap(nodes);

  // Seed each node in a small sphere around its region's anchor
  const simNodes: SimNode[] = nodes.map((m) => {
    const ri = regionIndexFor(m, regionMap);
    const region = BRAIN_REGIONS[ri];
    let dx = 0, dy = 0, dz = 0;
    do {
      dx = rand() * 2 - 1;
      dy = rand() * 2 - 1;
      dz = rand() * 2 - 1;
    } while (dx * dx + dy * dy + dz * dz > 1);
    return {
      id: m.id,
      domain: m.domain,
      regionIndex: ri,
      lobe: lobeForRegion(ri),
      x: region.anchor[0] + dx * region.radius,
      y: region.anchor[1] + dy * region.radius,
      z: region.anchor[2] + dz * region.radius,
    };
  });

  const links = edges.map((e) => ({ source: e.source, target: e.target, cross: e.type === 'derived_from' && nodesAreCross(e, nodes) }));

  // ---- forceRegion: weak pull toward region anchor (keeps clusters distinct) ----
  function forceRegion() {
    let ns: SimNode[] = [];
    const force = (alpha: number) => {
      for (const n of ns) {
        const r = BRAIN_REGIONS[n.regionIndex];
        n.x += (r.anchor[0] - n.x) * 0.04 * alpha;
        n.y += (r.anchor[1] - n.y) * 0.04 * alpha;
        n.z += (r.anchor[2] - n.z) * 0.04 * alpha;
      }
    };
    force.initialize = (nodes_: SimNode[]) => { ns = nodes_; };
    return force;
  }

  // ---- forceCerebrum: containment for cerebrum regions (0-7) ----
  function forceCerebrum() {
    let ns: SimNode[] = [];
    const force = (alpha: number) => {
      for (const n of ns) {
        if (n.regionIndex >= 8) continue; // cerebellum/stem handled by their own forces
        const d = cerebrumUnit2(n.x, n.y, n.z, n.lobe);
        if (d > 1) {
          const s = 1 / Math.sqrt(d);
          const lx = (n.x - n.lobe) * s;
          const ly = (n.y - CY) * s;
          const lz = n.z * s;
          n.x = n.lobe + lx;
          n.y = CY + ly;
          n.z = lz;
          const vn = n as unknown as { vx: number; vy: number; vz: number };
          vn.vx *= 0.2 * alpha + 0.2;
          vn.vy *= 0.2 * alpha + 0.2;
          vn.vz *= 0.2 * alpha + 0.2;
        }
      }
    };
    force.initialize = (nodes_: SimNode[]) => { ns = nodes_; };
    return force;
  }

  // ---- forceCerebellum: containment for cerebellum region (8) ----
  function forceCerebellum() {
    let ns: SimNode[] = [];
    const force = (alpha: number) => {
      for (const n of ns) {
        if (n.regionIndex !== 8) continue;
        const d = cerebellumUnit2(n.x, n.y, n.z);
        if (d > 1) {
          const s = 1 / Math.sqrt(d);
          n.x = CB_CX + (n.x - CB_CX) * s;
          n.y = CB_CY + (n.y - CB_CY) * s;
          n.z = CB_CZ + (n.z - CB_CZ) * s;
          const vn = n as unknown as { vx: number; vy: number; vz: number };
          vn.vx *= 0.2 * alpha + 0.2;
          vn.vy *= 0.2 * alpha + 0.2;
          vn.vz *= 0.2 * alpha + 0.2;
        }
      }
    };
    force.initialize = (nodes_: SimNode[]) => { ns = nodes_; };
    return force;
  }

  // ---- forceStem: containment for brain stem region (9) — thin cylinder ----
  function forceStem() {
    let ns: SimNode[] = [];
    const force = (alpha: number) => {
      for (const n of ns) {
        if (n.regionIndex !== 9) continue;
        // Project x,z toward the stem axis (x≈0, z≈0 to 0.45 — use z = n.z clamped)
        const distXZ = Math.sqrt(n.x * n.x + (n.z - 0.1) * (n.z - 0.1));
        if (distXZ > STEM_RADIUS) {
          const s = STEM_RADIUS / distXZ;
          n.x = n.x * s;
          n.z = 0.1 + (n.z - 0.1) * s;
          const vn = n as unknown as { vx: number; vz: number };
          vn.vx *= 0.2 * alpha + 0.2;
          vn.vz *= 0.2 * alpha + 0.2;
        }
        // Clamp y to the stem extent [-4.9, -1.9]
        if (n.y > -1.9) n.y = -1.9;
        if (n.y < -4.9) n.y = -4.9;
      }
    };
    force.initialize = (nodes_: SimNode[]) => { ns = nodes_; };
    return force;
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  // Pass numDimensions=3 as the SECOND ARG to forceSimulation — not .numDimensions(3)
  // after. The constructor calls initializeNodes() which sets vz=0 only when nDim>2
  // from the start. Calling .numDimensions(3) after construction re-initializes forces
  // but NOT nodes, leaving vz=undefined → NaN propagates through all z-forces.
  const sim = (forceSimulation(simNodes as never[], 3) as any)
    .force(
      'link',
      (forceLink as any)(links)
        .id((n: SimNode) => n.id)
        .distance((l: any) => (l.cross ? 4.6 : 2.1))
        .strength(0.12),
    )
    .force('charge', (forceManyBody() as any).strength(-0.85))
    .force('region', forceRegion())
    .force('cerebrum', forceCerebrum())
    .force('cerebellum', forceCerebellum())
    .force('stem', forceStem())
    .stop();

  // Synchronous deterministic relaxation
  for (let i = 0; i < 160; i++) sim.tick();

  // Final hard projection: guarantee every node rests inside its containing volume
  for (const n of simNodes) {
    if (n.regionIndex < 8) {
      const d = cerebrumUnit2(n.x, n.y, n.z, n.lobe);
      if (d > 1) {
        const s = 1 / Math.sqrt(d);
        n.x = n.lobe + (n.x - n.lobe) * s;
        n.y = CY + (n.y - CY) * s;
        n.z = n.z * s;
      }
    } else if (n.regionIndex === 8) {
      const d = cerebellumUnit2(n.x, n.y, n.z);
      if (d > 1) {
        const s = 1 / Math.sqrt(d);
        n.x = CB_CX + (n.x - CB_CX) * s;
        n.y = CB_CY + (n.y - CB_CY) * s;
        n.z = CB_CZ + (n.z - CB_CZ) * s;
      }
    } else {
      // stem
      const distXZ = Math.sqrt(n.x * n.x + (n.z - 0.1) * (n.z - 0.1));
      if (distXZ > STEM_RADIUS) {
        const s = STEM_RADIUS / distXZ;
        n.x = n.x * s;
        n.z = 0.1 + (n.z - 0.1) * s;
      }
      if (n.y > -1.9) n.y = -1.9;
      if (n.y < -4.9) n.y = -4.9;
    }
  }

  const map: PositionMap = new Map();
  for (const n of simNodes) map.set(n.id, [n.x, n.y, n.z]);
  return map;
}

function nodesAreCross(e: GraphEdge, nodes: Memory[]): boolean {
  const a = nodes.find((n) => n.id === e.source);
  const b = nodes.find((n) => n.id === e.target);
  return !!a && !!b && a.scope !== b.scope;
}
