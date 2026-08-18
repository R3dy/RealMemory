import { useMemo } from 'react';
import { Html } from '@react-three/drei';
import type { Memory } from '@/lib/data';
import { TYPE_COLORS, weightColor, domainColor } from '@/lib/colors';
import { useUiStore } from '@/lib/ui-store';
import type { ColorMode } from '@/lib/ui-store';

// ---------------------------------------------------------------------------
// MemoryLabels — floating billboard labels with the memory's actual content.
// Shown for: ~10 highest-weight visible memories + hovered + selected + its
// 1-hop neighbors. DOM (drei Html) so text stays crisp at any zoom; the label
// set is tiny (≤24) so 60fps is unaffected.
// ---------------------------------------------------------------------------

const MAX_LABELS = 24;
const TOP_COUNT = 10;
const CONTENT_CHARS = 45;

interface LabelEntry {
  index: number;
  kind: 'top' | 'focus' | 'hop';
}

export interface MemoryLabelsProps {
  nodes: Memory[];
  positions: [number, number, number][];
  neighbors: Set<number>[];
  weight: number[];
  matchIds: Set<string>;
  hoverId: string | null;
  selectedId: string | null;
  colorMode: ColorMode;
  regionMap: Map<string, number>;
}

export default function MemoryLabels({
  nodes,
  positions,
  neighbors,
  weight,
  matchIds,
  hoverId,
  selectedId,
  colorMode,
  regionMap,
}: MemoryLabelsProps) {
  const { labels } = useUiStore();

  const entries = useMemo<LabelEntry[]>(() => {
    if (!labels) return [];
    const picked = new Map<number, LabelEntry['kind']>();

    // top-N highest-weight visible memories
    const visible: number[] = [];
    for (let i = 0; i < nodes.length; i++) if (matchIds.has(nodes[i].id)) visible.push(i);
    visible.sort((a, b) => weight[b] - weight[a]);
    for (const i of visible.slice(0, TOP_COUNT)) picked.set(i, 'top');

    // hovered + selected node and their 1-hop neighborhood
    const addFocus = (id: string | null) => {
      if (!id) return;
      const idx = nodes.findIndex((n) => n.id === id);
      if (idx < 0) return;
      picked.set(idx, 'focus');
      neighbors[idx].forEach((j) => {
        if (!picked.has(j) && matchIds.has(nodes[j].id)) picked.set(j, 'hop');
      });
    };
    addFocus(selectedId);
    if (hoverId !== selectedId) addFocus(hoverId);

    return [...picked.entries()]
      .map(([index, kind]) => ({ index, kind }))
      .slice(0, MAX_LABELS);
  }, [labels, nodes, positions, neighbors, weight, matchIds, hoverId, selectedId]);

  if (!labels || entries.length === 0) return null;

  return (
    <group>
      {entries.map(({ index, kind }) => {
        const n = nodes[index];
        const [x, y, z] = positions[index];
        const color = colorMode === 'domain' ? domainColor(n, regionMap) : TYPE_COLORS[n.type];
        const focus = kind === 'focus';
        const content = n.content.length > CONTENT_CHARS ? `${n.content.slice(0, CONTENT_CHARS)}…` : n.content;
        return (
          <Html
            key={n.id}
            position={[x, y + 0.55 + weight[index] * 0.45, z]}
            center
            zIndexRange={[35, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <div
              className="flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-1.5 py-[3px] font-mono"
              style={{
                borderColor: focus ? color : 'rgba(0,212,255,0.22)',
                background: 'rgba(2,6,14,0.85)',
                boxShadow: focus ? `0 0 10px ${color}55` : '0 0 6px rgba(0,212,255,0.12)',
                fontSize: 10,
                lineHeight: 1.2,
                transform: 'translateZ(0)',
              }}
            >
              <span
                className="inline-block h-[7px] w-[3px] shrink-0"
                style={{ backgroundColor: color, boxShadow: `0 0 5px ${color}` }}
              />
              <span style={{ color: focus ? '#e8f6ff' : '#8fa9c7' }}>{content}</span>
              <span className="font-bold" style={{ color: weightColor(n.weight) }}>
                {n.weight.toFixed(2)}
              </span>
            </div>
          </Html>
        );
      })}
    </group>
  );
}
