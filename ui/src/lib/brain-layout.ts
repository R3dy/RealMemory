import { forceSimulation, forceLink, forceManyBody, forceX, forceY, forceZ } from 'd3-force-3d';
import { CEREBRUM } from '@/components/brain/brain-mesh';
import type { GraphEdge, Memory } from './data';

/**
 * Anatomical two-hemisphere brain layout.
 * Nodes seed into the owning cerebral hemisphere (left x<0 = project,
 * right x>0 = global), then a d3-force-3d pass relaxes them while lobe-anchor
 * forces preserve the hemisphere structure. Containment matches the
 * procedural cerebrum shell in `src/components/brain/brain-mesh.ts` — inset
 * so nodes float inside the cortical volume (never in the longitudinal
 * fissure crack) with a deep z spread for true volumetric structure.
 * Deterministic (fixed seed) so the brain is stable.
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

// Interior containment volume (inset from the shell surface / fold zone)
const LOBE_X = CEREBRUM.lobeX; // 3.45
const CY = CEREBRUM.cy; // 0.3
const RX_IN = CEREBRUM.rx * 0.76; // lateral — keeps |x| >= ~1.0 (out of the fissure)
const RY_TOP = CEREBRUM.ry * 0.76;
const RY_BOT = CEREBRUM.ry * 0.52 * 0.82; // flattened underside of the cerebrum
const RZ_IN = CEREBRUM.rz * 0.86; // deep front-back spread

interface SimNode {
  id: string;
  scope: string;
  x: number;
  y: number;
  z: number;
  lobe: number;
}

/** Normalized cerebrum distance² for a point (≤1 = inside the interior volume). */
export function cerebrumUnit2(x: number, y: number, z: number, lobe: number): number {
  const lx = (x - lobe) / RX_IN;
  const ly = (y - CY) / (y >= CY ? RY_TOP : RY_BOT);
  const lz = z / RZ_IN;
  return lx * lx + ly * ly + lz * lz;
}

export function computeBrainLayout(nodes: Memory[], edges: GraphEdge[]): PositionMap {
  const rand = mulberry32(0xb3a12025);

  // Seed inside the owning hemisphere volume
  const simNodes: SimNode[] = nodes.map((m) => {
    const lobe = m.scope === 'project' ? -LOBE_X : LOBE_X;
    // random point in unit sphere, squashed into the hemisphere interior
    let x = 0;
    let y = 0;
    let z = 0;
    do {
      x = rand() * 2 - 1;
      y = rand() * 2 - 1;
      z = rand() * 2 - 1;
    } while (x * x + y * y + z * z > 1);
    return {
      id: m.id,
      scope: m.scope,
      lobe,
      x: lobe + x * RX_IN * 0.85,
      y: CY + (y >= 0 ? y * RY_TOP : y * RY_BOT) * 0.85,
      z: z * RZ_IN * 0.9,
    };
  });

  const links = edges.map((e) => ({ source: e.source, target: e.target, cross: e.type === 'derived_from' && nodesAreCross(e, nodes) }));

  // Cerebrum containment force: pushes nodes back inside the hemisphere volume
  function forceCerebrum() {
    let ns: SimNode[] = [];
    const force = (alpha: number) => {
      for (const n of ns) {
        const d = cerebrumUnit2(n.x, n.y, n.z, n.lobe);
        if (d > 1) {
          // hard-project back onto the volume surface and damp outward velocity
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
    force.initialize = (nodes_: SimNode[]) => {
      ns = nodes_;
    };
    return force;
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  // numDimensions(3) is CRITICAL — d3-force-3d defaults to a 2D sim, which
  // flattens the brain into a plane (the old "reads as 2D" bug).
  const sim = (forceSimulation(simNodes as never[]) as any).numDimensions(3)
    .force(
      'link',
      (forceLink as any)(links)
        .id((n: SimNode) => n.id)
        .distance((l: any) => (l.cross ? 4.6 : 2.1))
        .strength(0.12),
    )
    .force('charge', (forceManyBody() as any).strength(-0.85))
    .force('lobeX', (forceX(((n: SimNode) => n.lobe) as never) as any).strength(0.3))
    .force('lobeY', (forceY(CY) as any).strength(0.06))
    // weaker z centering → noticeably deeper 3D spread through the volume
    .force('lobeZ', (forceZ(0) as any).strength(0.035))
    .force('shell', forceCerebrum())
    .stop();

  // Synchronous deterministic relaxation
  for (let i = 0; i < 160; i++) sim.tick();

  // Final hard projection: guarantee every node rests inside its hemisphere
  // volume (velocities can leave nodes marginally outside after the last tick)
  for (const n of simNodes) {
    const d = cerebrumUnit2(n.x, n.y, n.z, n.lobe);
    if (d > 1) {
      const s = 1 / Math.sqrt(d);
      n.x = n.lobe + (n.x - n.lobe) * s;
      n.y = CY + (n.y - CY) * s;
      n.z = n.z * s;
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
