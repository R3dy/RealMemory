import type { EdgeType, GraphEdge, Memory, MemoryType } from '@/lib/data';
import { EDGES, MEMORIES, getDomains, getGraph } from '@/lib/data';
import { weightTier } from '@/lib/colors';

/** Per-domain aggregate used by the Domain Atlas cards + comparison table. */
export interface DomainStats {
  name: string;
  count: number;
  avgWeight: number;
  tiers: { strong: number; stable: number; fading: number };
  typeCounts: Partial<Record<MemoryType, number>>;
  topType: MemoryType;
  topTags: string[]; // up to 4, by frequency
  topCategories: string[]; // up to 3, by frequency
  lastActivity: string; // ISO
  activeRecently: boolean; // any memory updated < 24h ago
  nodes: Memory[];
  edges: GraphEdge[];
}

const DAY_MS = 86_400_000;

export function computeDomainStats(): DomainStats[] {
  const now = Date.now();
  return getDomains().map((info) => {
    const { nodes, edges } = getGraph({ domain: info.name });

    const tiers = { strong: 0, stable: 0, fading: 0 };
    const typeCounts: Partial<Record<MemoryType, number>> = {};
    const tagFreq = new Map<string, number>();
    const catFreq = new Map<string, number>();
    let weightSum = 0;
    let lastActivity = '';
    let activeRecently = false;

    for (const m of nodes) {
      weightSum += m.weight;
      const tier = weightTier(m.weight);
      if (tier === 'strong') tiers.strong++;
      else if (tier === 'medium') tiers.stable++;
      else tiers.fading++; // weak + archive zone both read as FADING
      typeCounts[m.type] = (typeCounts[m.type] ?? 0) + 1;
      for (const t of m.tags) tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
      if (m.category) catFreq.set(m.category, (catFreq.get(m.category) ?? 0) + 1);
      if (m.updatedAt > lastActivity) lastActivity = m.updatedAt;
      if (now - new Date(m.updatedAt).getTime() < DAY_MS) activeRecently = true;
    }

    const topType = (Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
      'contextual_note') as MemoryType;
    const topTags = [...tagFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
    const topCategories = [...catFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c]) => c);

    return {
      name: info.name,
      count: nodes.length,
      avgWeight: nodes.length ? weightSum / nodes.length : 0,
      tiers,
      typeCounts,
      topType,
      topTags,
      topCategories,
      lastActivity,
      activeRecently,
      nodes,
      edges,
    };
  });
}

/** Inter-sector synapse: relationships whose source and target live in different domains. */
export interface CrossDomainLink {
  a: string;
  b: string;
  count: number;
  dominant: EdgeType;
}

export function computeCrossDomainLinks(): CrossDomainLink[] {
  const byId = new Map(MEMORIES.map((m) => [m.id, m]));
  const pairs = new Map<string, { a: string; b: string; count: number; types: Map<EdgeType, number> }>();

  for (const e of EDGES) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s?.domain || !t?.domain || s.domain === t.domain) continue;
    const [a, b] = s.domain < t.domain ? [s.domain, t.domain] : [t.domain, s.domain];
    const key = `${a}|${b}`;
    if (!pairs.has(key)) pairs.set(key, { a, b, count: 0, types: new Map() });
    const p = pairs.get(key)!;
    p.count++;
    p.types.set(e.type, (p.types.get(e.type) ?? 0) + 1);
  }

  return [...pairs.values()]
    .map((p) => ({
      a: p.a,
      b: p.b,
      count: p.count,
      dominant: [...p.types.entries()].sort((x, y) => y[1] - x[1])[0][0],
    }))
    .sort((x, y) => y.count - x.count);
}
