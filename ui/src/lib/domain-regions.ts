/**
 * Domain → anatomical brain region mapping.
 *
 * Standalone module (no UI deps) so it's testable from the repo-root vitest.
 * The full `Memory` type in `./data` satisfies `MemoryLike` structurally.
 */

export interface MemoryLike {
  id: string;
  domain?: string;
}

export interface BrainRegion {
  name: string;
  /** Seed center inside the brain volume (matches CEREBRUM/CEREBELLUM/stem anatomy). */
  anchor: [number, number, number];
  /** Seed scatter radius (how wide the domain's cluster spreads from the anchor). */
  radius: number;
  /** Neon color for this region's neurons. */
  color: string;
}

/**
 * 10 anatomical brain regions, ordered by prominence.
 * Regions 0-7 are cerebrum lobes (split left/right by parity):
 *   even index → left hemisphere (lobe = -LOBE_X), odd → right (+LOBE_X).
 * Regions 8-9 are cerebellum + brain stem (central, lobe = 0).
 *
 * Anchors are INSIDE the cerebrum/cerebellum/stem volumes per the anatomy
 * constants in `src/components/brain/brain-mesh.ts` (CEREBRUM rx=3.1/ry=4.05/
 * rz=3.45 centered at ±3.45,0.3,0; CEREBELLUM at 0,-2.75,-2.35; stem curve
 * from 0,-1.9,-0.75 to 0,-4.9,0.45).
 */
export const BRAIN_REGIONS: BrainRegion[] = [
  { name: 'Left Frontal',    anchor: [-2.3,  1.4,  2.4], radius: 1.1, color: '#ff3355' }, // scar red
  { name: 'Right Frontal',   anchor: [ 2.3,  1.4,  2.4], radius: 1.1, color: '#22ff88' }, // synapse green
  { name: 'Left Parietal',   anchor: [-2.0,  2.0, -1.2], radius: 1.0, color: '#4da6ff' }, // electric blue
  { name: 'Right Parietal',  anchor: [ 2.0,  2.0, -1.2], radius: 1.0, color: '#ffd319' }, // datum amber
  { name: 'Left Temporal',   anchor: [-2.6, -0.7,  1.0], radius: 0.9, color: '#b26bff' }, // engram violet
  { name: 'Right Temporal',  anchor: [ 2.6, -0.7,  1.0], radius: 0.9, color: '#ff9f1c' }, // reactor orange
  { name: 'Left Occipital',  anchor: [-1.6,  0.4, -2.6], radius: 0.8, color: '#00d4ff' }, // arc cyan
  { name: 'Right Occipital', anchor: [ 1.6,  0.4, -2.6], radius: 0.8, color: '#ff6b9d' }, // pink
  { name: 'Cerebellum',      anchor: [ 0,   -2.4, -2.0], radius: 0.7, color: '#7de9ff' }, // arc soft
  { name: 'Brain Stem',      anchor: [ 0,   -3.3,  0.1], radius: 0.4, color: '#8a97ab' }, // static gray (uncategorized)
];

/** Region index for undefined-domain memories (Brain Stem — gray, "uncategorized"). */
export const UNASSIGNED_REGION_INDEX = 9;

/**
 * Map domains present in the dataset to brain regions, by count descending.
 * The most frequent domain → region 0 (Left Frontal, most prominent).
 * Domains beyond the first 9 → Brain Stem (shared with uncategorized).
 *
 * Deterministic: the same node set always produces the same mapping.
 * Returns Map<domain, regionIndex>. Undefined-domain memories are NOT in the
 * map — callers handle them via `UNASSIGNED_REGION_INDEX`.
 */
export function computeDomainRegionMap<T extends MemoryLike>(nodes: T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    if (n.domain) counts.set(n.domain, (counts.get(n.domain) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const map = new Map<string, number>();
  sorted.forEach(([domain], i) => {
    // Domains 0-8 get their own region; 9+ overflow into the Brain Stem (region 9).
    map.set(domain, i < BRAIN_REGIONS.length - 1 ? i : BRAIN_REGIONS.length - 1);
  });
  return map;
}

/**
 * Resolve the region index for a single memory.
 * Undefined-domain → UNASSIGNED_REGION_INDEX (Brain Stem).
 */
export function regionIndexFor<T extends MemoryLike>(memory: T, regionMap: Map<string, number>): number {
  if (memory.domain) {
    const ri = regionMap.get(memory.domain);
    if (ri !== undefined) return ri;
  }
  return UNASSIGNED_REGION_INDEX;
}
