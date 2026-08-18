import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, RotateCcw, Search, X } from 'lucide-react';
import type { DomainInfo, MemoryType, Scope } from '@/lib/data';
import { CATEGORIES } from '@/lib/data';
import { TYPE_COLORS, ARCHIVE_THRESHOLD } from '@/lib/colors';
import SynapseTag from '@/components/SynapseTag';
import { cn } from '@/lib/utils';

export interface IndexFilters {
  q: string;
  types: Set<MemoryType>;
  categories: Set<string>;
  scope: Scope | 'all';
  domain: string | null;
  minWeight: number;
  createdAfter: string; // '' | yyyy-mm-dd
  createdBefore: string; // '' | yyyy-mm-dd
}

export const EMPTY_INDEX_FILTERS: IndexFilters = {
  q: '',
  types: new Set<MemoryType>(),
  categories: new Set<string>(),
  scope: 'all',
  domain: null,
  minWeight: 0,
  createdAfter: '',
  createdBefore: '',
};

const ALL_TYPES: MemoryType[] = [
  'user_preference',
  'task_pattern',
  'codebase_fact',
  'lesson_learned',
  'session_summary',
  'contextual_note',
];

function useClickOutside(onOut: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOut();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onOut]);
  return ref;
}

const inputCls =
  'rounded-md border border-panel-border bg-[rgba(2,6,14,0.5)] px-2.5 py-1.5 text-[13px] text-hi outline-none transition-colors placeholder:text-dim focus:border-panel-hot';

/** Dropdown shell with holo popover. */
function Dropdown({
  label,
  summary,
  children,
  className,
}: {
  label: string;
  summary: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-md border border-panel-border bg-[rgba(2,6,14,0.5)] px-2.5 py-1.5 text-left transition-colors hover:border-panel-hot',
          open && 'border-panel-hot',
        )}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="micro-label shrink-0">{label}</span>
          <span className="truncate font-mono text-[11px] text-arc">{summary}</span>
        </span>
        <ChevronDown
          size={13}
          className={cn('shrink-0 text-dim transition-transform duration-200', open && 'rotate-180')}
        />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="holo-panel holo-panel-solid holo-corners absolute left-0 top-full z-50 mt-1.5 min-w-full p-2"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * FilterCommandBar — memories.md §2.
 * Compact filter matrix + removable active-filter chips row.
 */
export default function FilterCommandBar({
  filters,
  onChange,
  domains,
}: {
  filters: IndexFilters;
  onChange: (f: IndexFilters) => void;
  domains: DomainInfo[];
}) {
  const set = (patch: Partial<IndexFilters>) => onChange({ ...filters, ...patch });

  const toggleType = (t: MemoryType) => {
    const next = new Set(filters.types);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    set({ types: next });
  };
  const toggleCategory = (c: string) => {
    const next = new Set(filters.categories);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    set({ categories: next });
  };

  const activeCount =
    filters.types.size +
    filters.categories.size +
    (filters.q ? 1 : 0) +
    (filters.scope !== 'all' ? 1 : 0) +
    (filters.domain ? 1 : 0) +
    (filters.minWeight > 0 ? 1 : 0) +
    (filters.createdAfter || filters.createdBefore ? 1 : 0);

  const chips: { key: string; label: string; color: string; clear: () => void }[] = [];
  if (filters.q)
    chips.push({
      key: 'q',
      label: `“${filters.q}”`,
      color: '#00d4ff',
      clear: () => set({ q: '' }),
    });
  for (const t of filters.types)
    chips.push({ key: `t-${t}`, label: t, color: TYPE_COLORS[t], clear: () => toggleType(t) });
  for (const c of filters.categories)
    chips.push({ key: `c-${c}`, label: c, color: '#ffb627', clear: () => toggleCategory(c) });
  if (filters.scope !== 'all')
    chips.push({
      key: 'scope',
      label: `scope:${filters.scope}`,
      color: filters.scope === 'project' ? '#00d4ff' : '#b26bff',
      clear: () => set({ scope: 'all' }),
    });
  if (filters.domain)
    chips.push({
      key: 'domain',
      label: `domain:${filters.domain}`,
      color: '#7de9ff',
      clear: () => set({ domain: null }),
    });
  if (filters.minWeight > 0)
    chips.push({
      key: 'minw',
      label: `weight ≥ ${filters.minWeight.toFixed(2)}`,
      color: '#ffb627',
      clear: () => set({ minWeight: 0 }),
    });
  if (filters.createdAfter || filters.createdBefore)
    chips.push({
      key: 'created',
      label: `created ${filters.createdAfter || '…'} → ${filters.createdBefore || '…'}`,
      color: '#8fa9c7',
      clear: () => set({ createdAfter: '', createdBefore: '' }),
    });

  return (
    <div className="holo-panel holo-corners">
      <div className="relative z-10 flex flex-wrap items-center gap-2.5 px-3 py-2.5">
        {/* search */}
        <div className="relative w-full min-w-[180px] max-w-[260px] flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-arc" />
          <input
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Search content + tags…"
            className={cn(inputCls, 'w-full pl-7')}
          />
        </div>

        {/* type multi-select */}
        <Dropdown
          label="Type"
          summary={filters.types.size ? `${filters.types.size}/6` : 'ALL'}
          className="w-[150px]"
        >
          <div className="flex w-[210px] flex-col gap-0.5">
            {ALL_TYPES.map((t) => {
              const on = filters.types.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleType(t)}
                  className={cn(
                    'flex items-center gap-2 rounded px-2 py-1.5 font-mono text-[11px] uppercase tracking-wide transition-colors',
                    on ? 'bg-[rgba(0,212,255,0.1)] text-hi' : 'text-mid hover:bg-[rgba(0,212,255,0.05)]',
                  )}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{
                      backgroundColor: TYPE_COLORS[t],
                      boxShadow: on ? `0 0 8px ${TYPE_COLORS[t]}` : undefined,
                    }}
                  />
                  {t.replace('_', ' ')}
                  <span className="ml-auto text-arc">{on ? '✓' : ''}</span>
                </button>
              );
            })}
          </div>
        </Dropdown>

        {/* domain dropdown */}
        <Dropdown
          label="Domain"
          summary={filters.domain ?? 'ALL'}
          className="w-[160px]"
        >
          <div className="flex max-h-56 w-[190px] flex-col gap-0.5 overflow-y-auto">
            <button
              type="button"
              onClick={() => set({ domain: null })}
              className={cn(
                'rounded px-2 py-1.5 text-left font-mono text-[11px] uppercase transition-colors',
                !filters.domain ? 'bg-[rgba(0,212,255,0.1)] text-hi' : 'text-mid hover:bg-[rgba(0,212,255,0.05)]',
              )}
            >
              ALL DOMAINS
            </button>
            {domains.map((d) => (
              <button
                key={d.name}
                type="button"
                onClick={() => set({ domain: d.name })}
                className={cn(
                  'flex items-center justify-between rounded px-2 py-1.5 font-mono text-[11px] uppercase transition-colors',
                  filters.domain === d.name
                    ? 'bg-[rgba(0,212,255,0.1)] text-hi'
                    : 'text-mid hover:bg-[rgba(0,212,255,0.05)]',
                )}
              >
                {d.name}
                <span className="rounded border border-panel-border px-1 text-[10px] text-dim">{d.count}</span>
              </button>
            ))}
          </div>
        </Dropdown>

        {/* scope segmented toggle */}
        <div className="relative flex items-center rounded-full border border-panel-border bg-[rgba(2,6,14,0.5)] p-[3px]">
          {(['project', 'global', 'all'] as const).map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => set({ scope: o })}
              className={cn(
                'relative z-10 rounded-full px-2.5 py-1 font-display text-[9px] font-bold tracking-[0.14em] transition-colors duration-200',
                filters.scope === o ? 'text-void' : 'text-dim hover:text-arc',
              )}
            >
              {filters.scope === o && (
                <motion.span
                  layoutId="idx-scope-thumb"
                  className="absolute inset-0 -z-10 rounded-full bg-arc shadow-[0_0_10px_rgba(0,212,255,0.5)]"
                  transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                />
              )}
              {o.toUpperCase()}
            </button>
          ))}
        </div>

        {/* min weight mini-slider (amber, red zone tick at 0.05) */}
        <div className="flex items-center gap-2 rounded-md border border-panel-border bg-[rgba(2,6,14,0.5)] px-2.5 py-1.5">
          <span className="micro-label shrink-0">W≥</span>
          <span className="relative flex items-center">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={filters.minWeight}
              onChange={(e) => set({ minWeight: Number(e.target.value) })}
              className="h-1 w-[110px] cursor-pointer appearance-none rounded-full bg-[rgba(0,212,255,0.15)] accent-[#ffb627]"
            />
            <span
              className="pointer-events-none absolute -bottom-1 h-2 w-px bg-danger"
              style={{ left: `${ARCHIVE_THRESHOLD * 100}%` }}
              title="AUTO-ARCHIVE ZONE < 0.05"
            />
          </span>
          <span className="w-8 font-mono text-[11px] font-bold text-reactor">
            {filters.minWeight.toFixed(2)}
          </span>
        </div>

        {/* created date range */}
        <div className="flex items-center gap-1.5 rounded-md border border-panel-border bg-[rgba(2,6,14,0.5)] px-2.5 py-1">
          <span className="micro-label shrink-0">Created</span>
          <input
            type="date"
            value={filters.createdAfter}
            onChange={(e) => set({ createdAfter: e.target.value })}
            className="w-[118px] bg-transparent font-mono text-[11px] text-mid outline-none [color-scheme:dark]"
          />
          <span className="text-dim">→</span>
          <input
            type="date"
            value={filters.createdBefore}
            onChange={(e) => set({ createdBefore: e.target.value })}
            className="w-[118px] bg-transparent font-mono text-[11px] text-mid outline-none [color-scheme:dark]"
          />
        </div>

        {/* reset */}
        <button
          type="button"
          onClick={() => onChange({ ...EMPTY_INDEX_FILTERS, types: new Set(), categories: new Set() })}
          className={cn(
            'ml-auto flex items-center gap-1.5 font-display text-[10px] font-bold tracking-[0.16em] transition-colors',
            activeCount > 0 ? 'text-reactor hover:text-hi' : 'cursor-default text-dim opacity-40',
          )}
        >
          <RotateCcw size={12} />
          RESET
        </button>
      </div>

      {/* category pills row (scrollable) */}
      <div className="relative z-10 flex items-center gap-1.5 overflow-x-auto border-t border-panel-border px-3 py-2">
        <span className="micro-label mr-1 shrink-0">Category</span>
        {CATEGORIES.map((c) => {
          const on = filters.categories.has(c);
          return (
            <button
              key={c}
              type="button"
              onClick={() => toggleCategory(c)}
              className={cn(
                'shrink-0 rounded-full border px-2.5 py-[3px] font-mono text-[11px] uppercase transition-all duration-200',
                on
                  ? 'border-[rgba(255,182,39,0.7)] bg-[rgba(255,182,39,0.18)] text-reactor shadow-[0_0_10px_rgba(255,182,39,0.25)]'
                  : 'border-panel-border bg-[rgba(255,182,39,0.05)] text-mid hover:border-[rgba(255,182,39,0.4)] hover:text-hi',
              )}
            >
              {c}
            </button>
          );
        })}
      </div>

      {/* active filter chips */}
      <AnimatePresence>
        {chips.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-10 overflow-hidden border-t border-panel-border"
          >
            <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
              <span className="micro-label mr-1">Active</span>
              <AnimatePresence mode="popLayout">
                {chips.map((chip) => (
                  <motion.span
                    key={chip.key}
                    layout
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 600, damping: 30 }}
                  >
                    <SynapseTag label={chip.label} color={chip.color} active dot={false} onClick={chip.clear} />
                  </motion.span>
                ))}
              </AnimatePresence>
              <button
                type="button"
                onClick={() => onChange({ ...EMPTY_INDEX_FILTERS, types: new Set(), categories: new Set() })}
                aria-label="Clear all filters"
                className="ml-1 flex items-center gap-1 font-mono text-[10px] uppercase text-dim transition-colors hover:text-danger"
              >
                <X size={11} /> clear all
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
