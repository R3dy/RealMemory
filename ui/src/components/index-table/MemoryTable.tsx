import { memo } from 'react';
import { motion } from 'framer-motion';
import { ArrowDown, ArrowUp, ChevronRight, Hexagon, RotateCcw, RotateCw } from 'lucide-react';
import type { Memory } from '@/lib/data';
import { TYPE_COLORS, weightColor } from '@/lib/colors';
import SynapseTag from '@/components/SynapseTag';
import { timeAgo, absoluteTime } from './hud';
import type { WeightBucket } from './WeightHistogram';
import { cn } from '@/lib/utils';

export type SortKey =
  | 'type'
  | 'domain'
  | 'category'
  | 'weight'
  | 'content'
  | 'tags'
  | 'createdAt'
  | 'updatedAt';
export type SortDir = 'asc' | 'desc';

export function sortMemories(rows: Memory[], key: SortKey, dir: SortDir): Memory[] {
  const mul = dir === 'asc' ? 1 : -1;
  const val = (m: Memory): string | number => {
    switch (key) {
      case 'type':
        return m.type;
      case 'domain':
        return m.domain ?? '￿'; // sort missing last
      case 'category':
        return m.category ?? '￿';
      case 'weight':
        return m.weight;
      case 'content':
        return m.content.toLowerCase();
      case 'tags':
        return m.tags.join(',').toLowerCase();
      case 'createdAt':
        return m.createdAt;
      case 'updatedAt':
        return m.updatedAt;
    }
  };
  return [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return 0;
  });
}

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: 'type', label: 'Type', className: 'w-[128px]' },
  { key: 'domain', label: 'Domain', className: 'w-[110px]' },
  { key: 'category', label: 'Category', className: 'w-[116px]' },
  { key: 'weight', label: 'Weight', className: 'w-[128px]' },
  { key: 'content', label: 'Content' },
  { key: 'tags', label: 'Tags', className: 'w-[190px]' },
  { key: 'createdAt', label: 'Created', className: 'w-[92px]' },
  { key: 'updatedAt', label: 'Updated', className: 'w-[92px]' },
];

const ARCHIVE_STRIPES =
  'repeating-linear-gradient(-45deg, rgba(138,151,171,0.10) 0 6px, transparent 6px 12px)';

const Row = memo(function Row({
  memory,
  index,
  dimmed,
  onOpen,
  onFocusInGraph,
}: {
  memory: Memory;
  index: number;
  dimmed: boolean;
  onOpen: (m: Memory) => void;
  onFocusInGraph: (m: Memory) => void;
}) {
  const typeColor = TYPE_COLORS[memory.type];
  const wColor = weightColor(memory.weight);
  const archived = memory.status === 'archived';
  const shownTags = memory.tags.slice(0, 3);
  const overflow = memory.tags.length - shownTags.length;

  return (
    <motion.tr
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: dimmed ? 0.3 : archived ? 0.45 : 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{
        opacity: { duration: 0.25 },
        y: { duration: 0.3, delay: Math.min(index * 0.025, 0.4), ease: [0.22, 1, 0.36, 1] },
        layout: { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
      }}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) onFocusInGraph(memory);
        else onOpen(memory);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onFocusInGraph(memory);
        }
      }}
      className={cn(
        'group relative h-[52px] cursor-pointer border-b border-[rgba(0,212,255,0.06)] transition-colors duration-200',
        index % 2 === 1 && 'bg-[rgba(0,212,255,0.02)]',
        'hover:bg-[rgba(0,212,255,0.06)]',
      )}
    >
      {/* TYPE — 10px neuron dot + micro label (+ 3px left bar via first cell) */}
      <td className="relative py-0 pl-4 pr-2">
        <span
          className="absolute left-0 top-0 h-full w-[3px] transition-shadow duration-200 group-hover:shadow-[0_0_10px_currentColor]"
          style={{ backgroundColor: typeColor, color: typeColor }}
        />
        {archived && <span className="absolute inset-0" style={{ background: ARCHIVE_STRIPES }} />}
        <span className="relative flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: typeColor, boxShadow: `0 0 6px ${typeColor}` }}
          />
          <span className="font-display text-[9px] font-bold tracking-[0.12em] text-mid">
            {memory.type.replace('_', ' ').toUpperCase()}
          </span>
        </span>
      </td>
      {/* DOMAIN */}
      <td className="px-2 py-0">
        {memory.domain ? (
          <SynapseTag label={memory.domain} color="#7de9ff" dot={false} />
        ) : (
          <span className="text-dim">—</span>
        )}
      </td>
      {/* CATEGORY */}
      <td className="px-2 py-0">
        {memory.category ? (
          <SynapseTag label={memory.category} color="#ffb627" dot={false} />
        ) : (
          <span className="text-dim">—</span>
        )}
      </td>
      {/* WEIGHT — mini bar + mono */}
      <td className="px-2 py-0">
        <span className="flex items-center gap-2">
          <span className="h-[5px] w-[60px] overflow-hidden rounded-full bg-[rgba(0,212,255,0.1)]">
            <motion.span
              className="block h-full rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${memory.weight * 100}%` }}
              transition={{ duration: 0.5, delay: Math.min(index * 0.025, 0.4), ease: [0.22, 1, 0.36, 1] }}
              style={{ backgroundColor: wColor, boxShadow: `0 0 6px ${wColor}` }}
            />
          </span>
          <span className="font-mono text-[12px] font-bold" style={{ color: wColor }}>
            {memory.weight.toFixed(2)}
          </span>
        </span>
      </td>
      {/* CONTENT — 1-line clamp, tooltip */}
      <td className="max-w-0 px-2 py-0" title={memory.content}>
        <span className="block truncate text-[15px] text-hi">{memory.content}</span>
      </td>
      {/* TAGS — up to 3 + overflow */}
      <td className="px-2 py-0">
        <span className="flex items-center gap-1 overflow-hidden">
          {shownTags.map((t) => (
            <span
              key={t}
              className="shrink-0 rounded border border-panel-border bg-[rgba(0,212,255,0.06)] px-1.5 py-[1px] font-mono text-[10px] text-mid"
            >
              {t}
            </span>
          ))}
          {overflow > 0 && <span className="font-mono text-[10px] text-dim">+{overflow}</span>}
        </span>
      </td>
      {/* CREATED */}
      <td className="px-2 py-0" title={absoluteTime(memory.createdAt)}>
        <span className="whitespace-nowrap font-mono text-[11px] text-mid">{timeAgo(memory.createdAt)}</span>
      </td>
      {/* UPDATED */}
      <td className="px-2 py-0" title={absoluteTime(memory.updatedAt)}>
        <span className="whitespace-nowrap font-mono text-[11px] text-mid">{timeAgo(memory.updatedAt)}</span>
      </td>
      {/* accessCount + chevron (+ archived pill) */}
      <td className="py-0 pl-2 pr-3">
        <span className="flex items-center justify-end gap-2">
          {archived && (
            <span className="rounded border border-[rgba(138,151,171,0.4)] bg-[rgba(138,151,171,0.12)] px-1.5 py-[1px] font-mono text-[9px] uppercase text-[#8a97ab]">
              Archived
            </span>
          )}
          <span className="flex items-center gap-0.5 font-mono text-[11px] text-dim" title={`${memory.accessCount} recalls`}>
            <RotateCw size={10} className="text-arc-dim" />
            {memory.accessCount}
          </span>
          <ChevronRight
            size={14}
            className="text-dim transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-arc"
          />
        </span>
      </td>
    </motion.tr>
  );
});

/**
 * MemoryTable — memories.md §3. Dense sortable holo data table.
 */
export default function MemoryTable({
  rows,
  sortKey,
  sortDir,
  onSort,
  highlightBucket,
  onOpen,
  onFocusInGraph,
  onReset,
}: {
  rows: Memory[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  highlightBucket: WeightBucket | null;
  onOpen: (m: Memory) => void;
  onFocusInGraph: (m: Memory) => void;
  onReset: () => void;
}) {
  return (
    <table className="w-full border-collapse" style={{ tableLayout: 'fixed' }}>
      <thead className="sticky top-0 z-20">
        <tr className="bg-[rgba(5,11,24,0.95)] backdrop-blur-[14px]">
          {COLUMNS.map((col) => {
            const active = sortKey === col.key;
            return (
              <th key={col.key} className={cn('border-b border-panel-border px-2 py-2 text-left first:pl-4', col.className)}>
                <button
                  type="button"
                  onClick={() => onSort(col.key)}
                  className={cn(
                    'flex items-center gap-1 font-display text-[10px] font-bold tracking-[0.16em] transition-colors',
                    active ? 'text-arc' : 'text-dim hover:text-hi',
                  )}
                >
                  {col.label.toUpperCase()}
                  <span
                    className={cn(
                      'inline-flex transition-transform duration-200',
                      active ? 'opacity-100' : 'opacity-0 group-hover:opacity-40',
                    )}
                  >
                    {active && sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
                  </span>
                </button>
              </th>
            );
          })}
          <th className="w-[110px] border-b border-panel-border py-2 pl-2 pr-3 text-right">
            <span className="font-display text-[10px] font-bold tracking-[0.16em] text-dim">RECALLS</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m, i) => {
          const dimmed =
            highlightBucket !== null && (m.weight < highlightBucket.min || m.weight >= highlightBucket.max);
          return (
            <Row
              key={m.id}
              memory={m}
              index={i}
              dimmed={dimmed}
              onOpen={onOpen}
              onFocusInGraph={onFocusInGraph}
            />
          );
        })}
        {rows.length === 0 && (
          <tr>
            <td colSpan={COLUMNS.length + 1}>
              <div className="flex h-[240px] flex-col items-center justify-center gap-4">
                <Hexagon
                  size={44}
                  className="text-dim"
                  style={{
                    filter: 'drop-shadow(0 0 8px rgba(0,212,255,0.2))',
                    // hex texture hint via the shared grid asset
                    WebkitMaskImage: 'none',
                    backgroundImage: 'url(/grid-hex.svg)',
                    backgroundSize: '24px',
                    backgroundBlendMode: 'overlay',
                  }}
                />
                <span className="font-display text-[13px] font-bold tracking-[0.2em] text-mid">
                  NO ENGRAMS IN THIS SLICE
                </span>
                <button
                  type="button"
                  onClick={onReset}
                  className="flex items-center gap-1.5 rounded-md border border-panel-hot px-4 py-1.5 font-display text-[10px] font-bold tracking-[0.18em] text-arc transition-shadow hover:shadow-glow-arc"
                >
                  <RotateCcw size={12} />
                  RESET MATRIX
                </button>
              </div>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
