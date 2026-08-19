import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AnimatePresence, motion } from 'framer-motion';
import gsap from 'gsap';
import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  ListFilter,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import type { GraphFilters, Memory, MemoryType } from '@/lib/data';
import { MEMORIES, EDGES, getGraph, getStats, getDomains, getMemory } from '@/lib/data';
import { TYPE_COLORS, EDGE_COLORS, weightColor, weightLabel, SCOPE_COLORS } from '@/lib/colors';
import { uiStore, useUiStore } from '@/lib/ui-store';
import { computeDomainRegionMap } from '@/lib/domain-regions';
import { BRAIN_REGIONS } from '@/lib/domain-regions';
import HoloPanel from '@/components/HoloPanel';
import SynapseTag from '@/components/SynapseTag';
import NodeDetailDrawer from '@/components/NodeDetailDrawer';
import MemoryCard from '@/components/MemoryCard';
import { cn } from '@/lib/utils';

const BrainCanvas = lazy(() => import('@/components/brain/BrainCanvas'));

// 3D perf discipline caps (degrade gracefully beyond)
const MAX_NODES = 400;
const MAX_EDGES = 800;

const ALL_TYPES: MemoryType[] = [
  'user_preference',
  'task_pattern',
  'codebase_fact',
  'lesson_learned',
  'session_summary',
  'contextual_note',
];
const ALL_CATEGORIES = ['gotcha', 'cost', 'safety', 'integration', 'process', 'tooling', 'performance'];

// ---------------------------------------------------------------------------
// WebGL detection
// ---------------------------------------------------------------------------

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Count-up numeral (800ms expo-out on mount)
// ---------------------------------------------------------------------------

function CountUp({ value, decimals = 0, className }: { value: number; decimals?: number; className?: string }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 800);
      setV(value * (1 - Math.pow(2, -10 * p)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setV(value);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className={className}>{v.toFixed(decimals)}</span>;
}

// ---------------------------------------------------------------------------
// Boot sequence — home.md §1 (GSAP timeline, skippable, first visit only)
// ---------------------------------------------------------------------------

const SCRAMBLE = '01<>/\\|#$%&@*+=?ABCDEF';

function BootSequence({ onDone }: { onDone: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const wordRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const stats = useMemo(() => getStats(), []);

  useEffect(() => {
    fetch('/boot-reactor.svg')
      .then((r) => r.text())
      .then(setSvg)
      .catch(() => setSvg(''));
  }, []);

  useEffect(() => {
    if (!svg || !rootRef.current) return;
    const root = rootRef.current;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });
      // rings
      tl.to('#ring-outer', { rotation: 360, duration: 1.2, ease: 'none', transformOrigin: '50% 50%' }, 0);
      tl.to('#ring-mid', { rotation: -180, duration: 2.2, ease: 'none', transformOrigin: '50% 50%' }, 0);
      tl.to('#ring-inner', { rotation: 90, duration: 2.0, ease: 'none', transformOrigin: '50% 50%' }, 0);
      // progress arc
      tl.to('#progress-arc', { strokeDashoffset: 0, duration: 1.5, ease: 'expo.out' }, 0.1);
      // core flare at 80%
      tl.fromTo(
        '#core',
        { scale: 0.8, transformOrigin: '50% 50%' },
        { scale: 1, duration: 0.4, ease: 'back.out(2)' },
        1.7,
      );
      tl.to('#core-dot', { attr: { r: 14 }, duration: 0.3, yoyo: true, repeat: 1 }, 1.9);

      // decode-scramble wordmark
      const target = 'REALMEMORY // NEURAL INTERFACE';
      const word = wordRef.current!;
      const scramble = { p: 0 };
      tl.to(
        scramble,
        {
          p: 1,
          duration: 0.6,
          ease: 'none',
          onUpdate: () => {
            const n = Math.floor(scramble.p * target.length);
            word.textContent =
              target.slice(0, n) +
              target
                .slice(n)
                .split('')
                .map((c) => (c === ' ' ? ' ' : SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)]))
                .join('');
          },
          onComplete: () => {
            word.textContent = target;
          },
        },
        0.5,
      );

      // status log lines
      const lines = [
        '> establishing neural link ......... OK',
        `> loading ${stats.totalMemories} engrams · ${stats.totalRelationships} synapses ... OK`,
        '> cortical render online',
      ];
      lines.forEach((line, i) => {
        tl.call(
          () => {
            const el = document.createElement('div');
            el.textContent = line;
            el.className = 'boot-log-line';
            logRef.current?.appendChild(el);
          },
          undefined,
          1.0 + i * 0.15,
        );
      });

      // hint
      tl.fromTo('.boot-hint', { opacity: 0 }, { opacity: 1, duration: 0.3 }, 2.0);

      // exit
      tl.to(root, {
        clipPath: 'inset(0 0 100% 0)',
        duration: 0.5,
        ease: 'expo.inOut',
        onComplete: onDone,
      }, 2.4);
    }, root);

    const skip = () => {
      ctx.revert();
      onDone();
    };
    root.addEventListener('click', skip);
    return () => {
      root.removeEventListener('click', skip);
      ctx.revert();
    };
  }, [svg, stats, onDone]);

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[100] flex cursor-pointer flex-col items-center justify-center bg-void"
      style={{ clipPath: 'inset(0 0 0 0)' }}
    >
      <div
        className="h-40 w-40 [&>svg]:h-full [&>svg]:w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div ref={wordRef} className="font-display mt-6 h-6 text-[18px] font-bold text-hi text-glow" />
      <div ref={logRef} className="mt-4 h-16 font-mono text-[11px] leading-relaxed text-mid [&_.boot-log-line]:opacity-90" />
      <div className="boot-hint micro-label mt-4 opacity-0">CLICK TO SKIP</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats bar — home.md §2 (second row, five readouts)
// ---------------------------------------------------------------------------

function StatsBar({ booted }: { booted: boolean }) {
  const { dataVersion, aggregateVersion } = useUiStore();
  const ver = dataVersion + aggregateVersion;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stats = useMemo(() => getStats(), [ver]);
  const avgWeight = useMemo(
    () => MEMORIES.reduce((s, m) => s + m.weight, 0) / Math.max(1, MEMORIES.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ver],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const archived = useMemo(() => MEMORIES.filter((m) => m.status === 'archived').length, [ver]);
  const projectPct = (stats.byScope.project / Math.max(1, stats.totalMemories)) * 100;

  if (!booted) return <div className="h-11 shrink-0 border-b border-panel-border" />;
  const cell = 'flex flex-col justify-center px-4';
  return (
    <motion.div
      initial={{ y: '-100%' }}
      animate={{ y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="flex h-11 shrink-0 items-stretch divide-x divide-[rgba(0,212,255,0.08)] border-b border-panel-border bg-[rgba(5,11,24,0.5)] backdrop-blur-[14px]"
    >
      <div className={cell}>
        <span className="micro-label">Total Memories</span>
        <CountUp value={stats.totalMemories} className="font-mono text-[18px] font-bold leading-none text-hi text-glow" />
      </div>
      <div className={cell}>
        <span className="micro-label">Synapses</span>
        <CountUp value={stats.totalRelationships} className="font-mono text-[18px] font-bold leading-none text-hi text-glow" />
      </div>
      <div className={cn(cell, 'min-w-[170px]')}>
        <span className="micro-label">Project / Global</span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] font-bold text-arc">{stats.byScope.project}</span>
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[rgba(178,107,255,0.35)]">
            <div className="h-full bg-arc" style={{ width: `${projectPct}%` }} />
          </div>
          <span className="font-mono text-[13px] font-bold text-[#b26bff]">{stats.byScope.global}</span>
        </div>
      </div>
      <div className={cell}>
        <span className="micro-label">Avg Weight</span>
        <CountUp value={avgWeight} decimals={2} className="font-mono text-[18px] font-bold leading-none text-reactor text-glow" />
      </div>
      <div className={cell}>
        <span className="micro-label">Archived</span>
        <CountUp value={archived} className="font-mono text-[18px] font-bold leading-none text-danger text-glow" />
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Filter matrix panel — home.md §4
// ---------------------------------------------------------------------------

export interface FilterState {
  domain: string | null;
  types: Set<MemoryType>;
  categories: Set<string>;
  tags: string[];
  minWeight: number;
  createdAfter: string;
  createdBefore: string;
}

export const EMPTY_FILTERS: FilterState = {
  domain: null,
  types: new Set(),
  categories: new Set(),
  tags: [],
  minWeight: 0,
  createdAfter: '',
  createdBefore: '',
};

function FilterSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[rgba(0,212,255,0.08)] px-4 py-3 last:border-0">
      <div className="micro-label mb-2">{label}</div>
      {children}
    </div>
  );
}

function FilterPanel({
  filters,
  onChange,
  booted,
}: {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  booted: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [openDomains, setOpenDomains] = useState<Set<string>>(new Set());
  const [tagInput, setTagInput] = useState('');
  const { dataVersion, aggregateVersion } = useUiStore();
  const ver = dataVersion + aggregateVersion;
  // eslint-disable-next-line react-hooks-exhaustive-deps
  const domains = useMemo(() => getDomains(), [ver]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stats = useMemo(() => getStats(), [ver]);

  const patch = (p: Partial<FilterState>) => onChange({ ...filters, ...p });

  const toggleDomainOpen = (d: string) =>
    setOpenDomains((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="holo-panel holo-panel-ghost absolute left-3 top-3 z-30 flex w-9 flex-col items-center gap-2 py-3"
        aria-label="Expand filter matrix"
      >
        <ListFilter size={14} className="text-arc" />
        <span className="micro-label" style={{ writingMode: 'vertical-rl' }}>
          FILTER MATRIX
        </span>
        <ChevronsRight size={12} className="text-dim" />
      </button>
    );
  }

  return (
    <motion.aside
      initial={{ x: -16, opacity: 0 }}
      animate={booted ? { x: 0, opacity: 1 } : {}}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
      className="absolute left-3 top-3 z-30 flex max-h-[calc(100%-72px)] w-[300px] flex-col"
    >
      <HoloPanel variant="ghost" title="Filter Matrix" className="flex min-h-0 flex-1 flex-col"
        headerRight={
          <button type="button" aria-label="Collapse filters" onClick={() => setCollapsed(true)} className="text-dim hover:text-arc">
            <ChevronsLeft size={14} />
          </button>
        }
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Domains tree */}
          <FilterSection label="Domains">
            <div className="space-y-0.5">
              {domains.map((d) => {
                const active = filters.domain === d.name;
                const open = openDomains.has(d.name);
                return (
                  <div key={d.name}>
                    <div
                      className={cn(
                        'flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 transition-colors',
                        active ? 'bg-[rgba(0,212,255,0.08)] text-hi shadow-[inset_2px_0_0_var(--arc)]' : 'text-mid hover:text-hi',
                      )}
                    >
                      <button type="button" onClick={() => toggleDomainOpen(d.name)} aria-label="Expand domain" className="text-dim">
                        <ChevronDown size={12} className={cn('transition-transform', !open && '-rotate-90')} />
                      </button>
                      <button
                        type="button"
                        className="flex-1 text-left font-body text-[14px] font-semibold"
                        onClick={() => patch({ domain: active ? null : d.name })}
                      >
                        {d.name}
                      </button>
                      <span className="rounded border border-panel-border px-1 font-mono text-[10px] text-dim">{d.count}</span>
                    </div>
                    {open && (
                      <div className="ml-6 space-y-0.5 border-l border-panel-border py-1 pl-2">
                        <div className="micro-label">types</div>
                        <div className="flex flex-wrap gap-1">
                          {d.types.map((t) => (
                            <span key={t} className="font-mono text-[10px]" style={{ color: TYPE_COLORS[t] }}>
                              {t}
                            </span>
                          ))}
                        </div>
                        {d.categories.length > 0 && <div className="micro-label mt-1">categories</div>}
                        <div className="flex flex-wrap gap-1">
                          {d.categories.map((c) => (
                            <span key={c} className="font-mono text-[10px] text-dim">
                              {c}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </FilterSection>

          {/* Memory type checkboxes */}
          <FilterSection label="Memory Type">
            <div className="space-y-1">
              {ALL_TYPES.map((t) => {
                const checked = filters.types.has(t);
                return (
                  <label key={t} className="flex cursor-pointer items-center gap-2 text-[13px] text-mid hover:text-hi">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const n = new Set(filters.types);
                        if (checked) n.delete(t);
                        else n.add(t);
                        patch({ types: n });
                      }}
                      className="h-3 w-3 accent-[#00d4ff]"
                    />
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: TYPE_COLORS[t], boxShadow: `0 0 6px ${TYPE_COLORS[t]}` }} />
                    <span className="flex-1 font-body">{t}</span>
                    <span className="font-mono text-[10px] text-dim">{stats.byType[t] ?? 0}</span>
                  </label>
                );
              })}
            </div>
          </FilterSection>

          {/* Category pills */}
          <FilterSection label="Category">
            <div className="flex flex-wrap gap-1.5">
              {ALL_CATEGORIES.map((c) => (
                <SynapseTag
                  key={c}
                  label={c}
                  color="#8fa9c7"
                  dot={false}
                  active={filters.categories.has(c)}
                  onClick={() => {
                    const n = new Set(filters.categories);
                    if (n.has(c)) n.delete(c);
                    else n.add(c);
                    patch({ categories: n });
                  }}
                />
              ))}
            </div>
          </FilterSection>

          {/* Scope radio (mirrors top bar) */}
          <FilterSection label="Scope">
            <ScopeRow />
          </FilterSection>

          {/* Tags token input */}
          <FilterSection label="Tags">
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-panel-border bg-[rgba(2,6,14,0.5)] p-1.5">
              {filters.tags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full border border-[rgba(0,212,255,0.4)] bg-[rgba(0,212,255,0.1)] px-2 py-[2px] font-mono text-[10px] text-arc">
                  {t}
                  <button type="button" aria-label={`Remove tag ${t}`} onClick={() => patch({ tags: filters.tags.filter((x) => x !== t) })}>
                    <X size={10} />
                  </button>
                </span>
              ))}
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && tagInput.trim()) {
                    patch({ tags: [...filters.tags, tagInput.trim().toLowerCase()] });
                    setTagInput('');
                  }
                }}
                placeholder="add tag + ↵"
                className="min-w-[80px] flex-1 bg-transparent font-mono text-[11px] text-hi outline-none placeholder:text-dim"
              />
            </div>
          </FilterSection>

          {/* Min weight slider */}
          <FilterSection label="Min Weight">
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={filters.minWeight}
                onChange={(e) => patch({ minWeight: Number(e.target.value) })}
                className="w-full accent-[#ffb627]"
              />
              <span className="w-10 text-right font-mono text-[11px] font-bold text-reactor">{filters.minWeight.toFixed(2)}</span>
            </div>
            <div className="relative mt-1 h-3">
              <span className="absolute left-[5%] top-0 h-1.5 w-px bg-danger" />
              <span className="absolute left-[5%] top-1.5 -translate-x-1/2 font-mono text-[8px] text-danger">AUTO-ARCHIVE</span>
            </div>
          </FilterSection>

          {/* Created range */}
          <FilterSection label="Created">
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={filters.createdAfter}
                onChange={(e) => patch({ createdAfter: e.target.value })}
                className="rounded border border-panel-border bg-[rgba(2,6,14,0.5)] px-2 py-1 font-mono text-[10px] text-mid outline-none focus:border-panel-hot"
              />
              <input
                type="date"
                value={filters.createdBefore}
                onChange={(e) => patch({ createdBefore: e.target.value })}
                className="rounded border border-panel-border bg-[rgba(2,6,14,0.5)] px-2 py-1 font-mono text-[10px] text-mid outline-none focus:border-panel-hot"
              />
            </div>
          </FilterSection>
        </div>

        {/* Footer */}
        <div className="border-t border-panel-border p-3">
          <button
            type="button"
            onClick={() => onChange({ ...EMPTY_FILTERS, types: new Set(), categories: new Set(), tags: [] })}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-panel-border py-1.5 font-display text-[10px] font-bold tracking-[0.18em] text-dim transition-all duration-300 hover:border-panel-hot hover:text-arc"
          >
            <RotateCcw size={12} /> RESET MATRIX
          </button>
        </div>
      </HoloPanel>
    </motion.aside>
  );
}

function ScopeRow() {
  const { scope } = useUiStore();
  return (
    <div className="flex gap-1">
      {(['project', 'global', 'all'] as const).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => uiStore.set({ scope: s })}
          className={cn(
            'flex-1 rounded-md border px-2 py-1 font-display text-[10px] font-bold tracking-[0.14em] transition-colors',
            scope === s ? 'border-panel-hot bg-[rgba(0,212,255,0.12)] text-arc' : 'border-panel-border text-dim hover:text-hi',
          )}
        >
          {s.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event ticker — design.md §7.10 / home.md §7
// ---------------------------------------------------------------------------

const TICKER_EVENTS = [
  () => {
    const m = MEMORIES[Math.floor(Math.random() * MEMORIES.length)];
    return `▸ RECALL HIT · ${m.type} · ${m.domain ?? 'global'} · w ${m.weight.toFixed(2)}`;
  },
  () => `▸ PREDICTION ERROR: ${['LOW', 'MED', 'HIGH'][Math.floor(Math.random() * 3)]} · lesson encoded`,
  () => `▸ REFLEX BLOCK · rm -rf build/ · rule R-${Math.floor(Math.random() * 30) + 1}`,
  () => {
    const m = MEMORIES[Math.floor(Math.random() * MEMORIES.length)];
    return `▸ REINFORCE · ${m.id.slice(0, 8)}… · weight +0.0${Math.floor(Math.random() * 4) + 1}`;
  },
  () => `▸ DECAY PASS · ${Math.floor(Math.random() * 12) + 2} engrams faded · 0 archived`,
  () => `▸ SCHEMA FORMATION · cluster ${Math.floor(Math.random() * 8) + 1} · ${Math.floor(Math.random() * 6) + 3} members`,
  () => `▸ WORKING MEMORY · slot rotated · goal pinned`,
];

function EventTicker({ booted }: { booted: boolean }) {
  const [items, setItems] = useState<string[]>(() => [TICKER_EVENTS[0]()]);
  useEffect(() => {
    if (!booted) return;
    const iv = window.setInterval(() => {
      setItems((prev) => [...prev.slice(-2), TICKER_EVENTS[Math.floor(Math.random() * TICKER_EVENTS.length)]()]);
    }, 5000);
    return () => window.clearInterval(iv);
  }, [booted]);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden font-mono text-[11px] text-mid">
      <AnimatePresence initial={false} mode="popLayout">
        {items.map((item, i) => (
          <motion.span
            key={`${item}-${i}`}
            layout="position"
            initial={{ x: 80, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -60, opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="flex shrink-0 items-center gap-2 whitespace-nowrap"
          >
            <span className="h-3 w-[2px] bg-arc shadow-[0_0_6px_var(--arc)]" />
            {item}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** HUD toggle for the floating memory labels on the 3D graph (default on). */
function LabelsToggle() {
  const { labels } = useUiStore();
  return (
    <button
      type="button"
      onClick={() => uiStore.set({ labels: !labels })}
      aria-pressed={labels}
      className={cn(
        'flex shrink-0 items-center gap-1.5 font-display text-[10px] font-bold tracking-[0.18em] transition-colors',
        labels ? 'text-arc' : 'text-dim hover:text-hi',
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full transition-shadow',
          labels ? 'bg-arc shadow-[0_0_6px_var(--arc)]' : 'bg-dim',
        )}
      />
      LABELS {labels ? 'ON' : 'OFF'}
    </button>
  );
}

/** HUD toggle for neuron coloring: domain (brain regions) ↔ type (memory type). */
function ColorModeToggle() {
  const { colorMode } = useUiStore();
  const isDomain = colorMode === 'domain';
  const color = isDomain ? '#ff3355' : '#ffd319';
  return (
    <button
      type="button"
      onClick={() => uiStore.set({ colorMode: isDomain ? 'type' : 'domain' })}
      aria-pressed={isDomain}
      className={cn(
        'flex shrink-0 items-center gap-1.5 font-display text-[10px] font-bold tracking-[0.18em] transition-colors',
        isDomain ? 'text-hi' : 'text-dim hover:text-hi',
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full transition-shadow',
          isDomain ? '' : 'bg-dim',
        )}
        style={isDomain ? { backgroundColor: color, boxShadow: `0 0 6px ${color}` } : undefined}
      />
      COLOR: {isDomain ? 'DOMAIN' : 'TYPE'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Legend — design.md §7.12
// ---------------------------------------------------------------------------

function Legend() {
  const [open, setOpen] = useState(false);
  const { colorMode, dataVersion } = useUiStore();
  // Domain region map + counts for the domain legend view
  const domainEntries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of MEMORIES) if (m.domain) counts.set(m.domain, (counts.get(m.domain) ?? 0) + 1);
    const rmap = computeDomainRegionMap(MEMORIES);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([domain, count]) => ({
        domain,
        count,
        region: BRAIN_REGIONS[rmap.get(domain) ?? 9],
      }));
  }, [dataVersion]);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 font-display text-[10px] font-bold tracking-[0.18em] text-dim transition-colors hover:text-arc"
      >
        LEGEND <ChevronDown size={12} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: 8, height: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="absolute bottom-8 right-0 z-40 w-[340px] overflow-hidden"
          >
            <HoloPanel variant="ghost" title="Legend" className="p-0">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 p-4">
                {colorMode === 'domain' ? (
                  <>
                    <div className="micro-label col-span-2">Neuron color = domain → brain region</div>
                    {domainEntries.map(({ domain, count, region }) => (
                      <div key={domain} className="flex items-center gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: region.color, boxShadow: `0 0 5px ${region.color}` }}
                        />
                        <span className="font-mono text-[10px] text-mid">{domain}</span>
                        <span className="ml-auto font-mono text-[9px] text-dim">{region.name}</span>
                        <span className="font-mono text-[9px] text-dim">{count}</span>
                      </div>
                    ))}
                    <div className="micro-label col-span-2 mt-2 text-arc">EACH DOMAIN = A BRAIN REGION</div>
                  </>
                ) : (
                  <>
                    <div className="micro-label col-span-2">Neuron = memory type</div>
                    {ALL_TYPES.map((t) => (
                      <div key={t} className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TYPE_COLORS[t], boxShadow: `0 0 5px ${TYPE_COLORS[t]}` }} />
                        <span className="font-mono text-[10px] text-mid">{t}</span>
                      </div>
                    ))}
                    <div className="micro-label col-span-2 mt-2 text-arc">REGIONS UNCHANGED · COLOR = TYPE</div>
                  </>
                )}
                <div className="micro-label col-span-2 mt-2">Synapse = relationship</div>
                {Object.entries(EDGE_COLORS).map(([e, c]) => (
                  <div key={e} className="flex items-center gap-2">
                    <svg width="22" height="6">
                      <line
                        x1="0"
                        y1="3"
                        x2="22"
                        y2="3"
                        stroke={c}
                        strokeWidth={e === 'derived_from' ? 3 : 1.5}
                        strokeDasharray={e === 'contradicts' || e === 'exception_to' ? '4 3' : undefined}
                        style={{ animation: 'dash-flow 1.2s linear infinite' }}
                      />
                    </svg>
                    <span className="font-mono text-[10px] text-mid">{e}</span>
                  </div>
                ))}
                <div className="micro-label col-span-2 mt-2">Weight tiers</div>
                <div className="col-span-2 flex gap-2 font-mono text-[10px]">
                  <span className="text-ok">STRONG &gt;.5</span>
                  <span className="text-[#ffd319]">STABLE &gt;.25</span>
                  <span className="text-danger">FADING ≤.25</span>
                </div>
                <div className="col-span-2 font-mono text-[10px] text-dim">IDLE ACTIVITY = spontaneous cascade</div>
                <div className="col-span-2 font-mono text-[10px] text-dim">SCROLL TO ENTER THE CORTEX · DBL-CLICK VOID TO DIVE</div>
              </div>
            </HoloPanel>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Command palette — design.md §7.11 / home.md §8
// ---------------------------------------------------------------------------

function CommandPalette({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { dataVersion } = useUiStore();

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const pool = needle
      ? MEMORIES.filter(
          (m) =>
            m.content.toLowerCase().includes(needle) ||
            m.id.toLowerCase().includes(needle) ||
            m.tags.some((t) => t.includes(needle)) ||
            (m.domain ?? '').includes(needle),
        )
      : [...MEMORIES].sort((a, b) => b.weight - a.weight);
    return pool.slice(0, 24);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, dataVersion]);

  const grouped = useMemo(() => {
    const map = new Map<MemoryType, Memory[]>();
    for (const m of results) {
      if (!map.has(m.type)) map.set(m.type, []);
      map.get(m.type)!.push(m);
    }
    return [...map.entries()];
  }, [results]);

  useEffect(() => {
    if (open) {
      setQ('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => setCursor(0), [q]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[90] flex items-start justify-center bg-[rgba(2,6,14,0.6)] pt-[14vh] backdrop-blur-[4px]"
          onClick={onClose}
        >
          <motion.div
            initial={{ clipPath: 'inset(0 0 100% 0)', opacity: 0 }}
            animate={{ clipPath: 'inset(0 0 0% 0)', opacity: 1 }}
            exit={{ clipPath: 'inset(0 0 100% 0)', opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="holo-panel holo-panel-solid holo-corners w-[560px] max-w-[92vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-panel-border px-4 py-3">
              <Search size={15} className="text-arc" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setCursor((c) => Math.min(results.length - 1, c + 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setCursor((c) => Math.max(0, c - 1));
                  } else if (e.key === 'Enter' && results[cursor]) {
                    onPick(results[cursor].id);
                    onClose();
                  } else if (e.key === 'Escape') onClose();
                }}
                placeholder="Search engrams by content, tag, ULID…"
                className="flex-1 bg-transparent font-body text-[15px] text-hi caret-[#00d4ff] outline-none placeholder:text-dim"
              />
              <kbd className="rounded border border-panel-border px-1.5 font-mono text-[10px] text-dim">esc</kbd>
            </div>
            <div className="max-h-[46vh] overflow-y-auto p-2">
              {results.length === 0 && (
                <div className="p-6 text-center font-display text-[11px] tracking-[0.18em] text-dim">
                  NO ENGRAMS MATCH
                </div>
              )}
              {(() => {
                let flat = -1;
                return grouped.map(([type, mems]) => (
                  <div key={type}>
                    <div className="micro-label px-2 pb-1 pt-2" style={{ color: TYPE_COLORS[type] }}>
                      {type}
                    </div>
                    {mems.map((m) => {
                      flat++;
                      const idx = flat;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onMouseEnter={() => setCursor(idx)}
                          onClick={() => {
                            onPick(m.id);
                            onClose();
                          }}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                            idx === cursor ? 'bg-[rgba(0,212,255,0.1)]' : '',
                          )}
                        >
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: TYPE_COLORS[m.type] }} />
                          <span className="line-clamp-1 flex-1 text-[13px] text-mid">{m.content}</span>
                          {m.domain && <SynapseTag label={m.domain} color="#7de9ff" dot={false} />}
                          <span className="font-mono text-[10px] font-bold" style={{ color: weightColor(m.weight) }}>
                            {m.weight.toFixed(2)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ));
              })()}
            </div>
            <div className="border-t border-panel-border px-4 py-2 font-mono text-[10px] text-dim">
              ↑↓ navigate · ↵ focus neuron · esc close
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Neuron tooltip — ghost holo-card following the cursor (80ms lag)
// ---------------------------------------------------------------------------

function NeuronTooltip({ memoryId, containerRef }: { memoryId: string | null; containerRef: React.RefObject<HTMLDivElement | null> }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const memory = memoryId ? getMemory(memoryId) : undefined;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      setPos({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener('pointermove', onMove);
    return () => el.removeEventListener('pointermove', onMove);
  }, [containerRef]);

  if (!memory || !pos) return null;
  return (
    <div
      className="holo-panel holo-panel-ghost pointer-events-none absolute z-40 w-[260px] p-3 transition-transform [transition-duration:80ms] ease-linear"
      style={{ transform: `translate(${pos.x + 18}px, ${pos.y + 14}px)`, top: 0, left: 0 }}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <SynapseTag label={memory.type} color={TYPE_COLORS[memory.type]} />
        <SynapseTag label={memory.scope} color={SCOPE_COLORS[memory.scope]} dot={false} />
      </div>
      <p className="line-clamp-2 text-[13px] leading-snug text-hi">{memory.content}</p>
      <div className="mt-1.5 flex items-center gap-3 font-mono text-[10px]">
        <span style={{ color: weightColor(memory.weight) }}>
          WEIGHT {memory.weight.toFixed(2)} · {weightLabel(memory.weight)}
        </span>
        <span className="text-dim">accessed {memory.accessCount}×</span>
        <span className="ml-auto text-dim">{memory.id.slice(0, 8)}…</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WebGL fallback — home.md §States
// ---------------------------------------------------------------------------

function WebGLFallback({ onSelect }: { onSelect: (id: string) => void }) {
  const { dataVersion } = useUiStore();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const top = useMemo(() => [...MEMORIES].sort((a, b) => b.weight - a.weight).slice(0, 12), [dataVersion]);
  return (
    <div className="absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 60% 45% at 50% 42%, rgba(0,212,255,0.14), rgba(178,107,255,0.06) 55%, transparent 75%)',
        }}
      />
      <div className="absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-full border border-[rgba(255,182,39,0.5)] bg-[rgba(255,182,39,0.1)] px-4 py-1.5 font-display text-[10px] font-bold tracking-[0.18em] text-reactor">
        CORTEX RENDER OFFLINE — INDEX MODE
      </div>
      <div className="absolute inset-x-4 bottom-14 top-14 overflow-y-auto pr-1">
        <div className="mx-auto grid max-w-4xl gap-2">
          {top.map((m) => (
            <MemoryCard key={m.id} memory={m} onClick={(mm) => onSelect(mm.id)} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HOME — NEURAL GRAPH (/)
// ---------------------------------------------------------------------------

export default function Home() {
  const [booted, setBooted] = useState(() => sessionStorage.getItem('rm-booted') === '1');
  const [showBoot, setShowBoot] = useState(() => sessionStorage.getItem('rm-booted') !== '1');
  const [webgl] = useState(webglAvailable);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [fireAt, setFireAt] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const containerRef = useRef<HTMLDivElement>(null);
  const { scope, dataVersion, colorMode } = useUiStore();

  const finishBoot = useCallback(() => {
    sessionStorage.setItem('rm-booted', '1');
    setShowBoot(false);
    setBooted(true);
  }, []);

  // filters → match ids (scope from the global HUD toggle)
  const matchIds = useMemo(() => {
    const gf: GraphFilters = {
      scope,
      type: filters.types.size ? [...filters.types] : undefined,
      domain: filters.domain ?? undefined,
      category: filters.categories.size ? [...filters.categories] : undefined,
      tags: filters.tags.length ? filters.tags : undefined,
      minWeight: filters.minWeight > 0 ? filters.minWeight : undefined,
      createdAfter: filters.createdAfter || undefined,
      createdBefore: filters.createdBefore ? `${filters.createdBefore}T23:59:59` : undefined,
    };
    return new Set(getGraph(gf).nodes.map((m) => m.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, scope, dataVersion]);

  // Canvas dataset — re-sliced on every dataset swap (dataVersion) so the
  // brain re-lays-out and re-renders without a reload. Perf caps: ≤400
  // neurons / ≤800 synapses, heaviest memories win.
  const canvasGraph = useMemo(() => {
    let nodes = [...MEMORIES];
    if (nodes.length > MAX_NODES) nodes = nodes.sort((a, b) => b.weight - a.weight).slice(0, MAX_NODES);
    const ids = new Set(nodes.map((n) => n.id));
    let edges = EDGES.filter((e) => ids.has(e.source) && ids.has(e.target));
    if (edges.length > MAX_EDGES) edges = edges.slice(0, MAX_EDGES);
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion]);

  // Domain → brain region map (deterministic, recomputed on dataset swap).
  // Shared by BrainCanvas (neuron colors) + Legend (domain→region→color grid).
  const regionMap = useMemo(() => computeDomainRegionMap(MEMORIES), [dataVersion]);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) setFireAt(performance.now());
  }, []);

  const navigateTo = useCallback(
    (id: string) => {
      // relationship jump: fly camera + open that engram's drawer
      setFocusId(id);
      select(id);
      setTimeout(() => setFocusId(null), 100);
    },
    [select],
  );

  // palette open requests (navbar ⌘K button)
  useEffect(() => {
    const onPalette = () => setPaletteOpen(true);
    window.addEventListener('realmemory:palette', onPalette);
    return () => window.removeEventListener('realmemory:palette', onPalette);
  }, []);

  // deep links: /?focus=<memoryId> (fly-to + drawer) · /?domain=<name> (filter matrix)
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const focus = searchParams.get('focus');
    const domain = searchParams.get('domain');
    if (!focus && !domain) return;
    if (domain && getDomains().some((d) => d.name === domain)) {
      setFilters((f) => ({ ...f, domain }));
    }
    if (focus && MEMORIES.some((m) => m.id === focus)) {
      setFocusId(focus);
      select(focus);
      setTimeout(() => setFocusId(null), 100);
    }
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keyboard: ⌘K / '/' palette · arrows cycle filtered nodes with fly-to
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (typing) return;
      if (e.key === '/') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === 'Escape') {
        setSelectedId(null);
        setPaletteOpen(false);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const pool = MEMORIES.filter((m) => matchIds.has(m.id));
        if (pool.length === 0) return;
        e.preventDefault();
        const cur = pool.findIndex((m) => m.id === selectedId);
        const next = e.key === 'ArrowRight' ? (cur + 1) % pool.length : (cur - 1 + pool.length) % pool.length;
        navigateTo(pool[next].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [matchIds, selectedId, navigateTo]);

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {showBoot && <BootSequence onDone={finishBoot} />}
      <StatsBar booted={booted} />

      <div ref={containerRef} className="relative min-h-0 flex-1">
        {/* nebula layer (60%) behind the transparent WebGL canvas */}
        <div
          className="absolute inset-0 opacity-60"
          style={{ background: 'url(/nebula-bg.png) center / cover no-repeat' }}
        />

        {webgl ? (
          <Suspense
            fallback={
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="font-display animate-pulse text-[11px] tracking-[0.2em] text-arc">
                  LOADING CORTEX…
                </span>
              </div>
            }
          >
            <BrainCanvas
              nodes={canvasGraph.nodes}
              edges={canvasGraph.edges}
              matchIds={matchIds}
              hoverId={hoverId}
              selectedId={selectedId}
              focusId={focusId}
              fireAt={fireAt}
              booted={booted}
              colorMode={colorMode}
              regionMap={regionMap}
              onHover={setHoverId}
              onSelect={select}
            />
          </Suspense>
        ) : (
          <WebGLFallback onSelect={navigateTo} />
        )}

        {/* empty filter state */}
        {matchIds.size === 0 && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-[rgba(2,6,14,0.35)]">
            <span className="font-display text-[15px] font-bold tracking-[0.2em] text-hi">
              NO ENGRAMS MATCH THIS MATRIX
            </span>
            <button
              type="button"
              onClick={() => setFilters({ ...EMPTY_FILTERS, types: new Set(), categories: new Set(), tags: [] })}
              className="rounded-md border border-panel-hot px-4 py-1.5 font-display text-[10px] font-bold tracking-[0.18em] text-arc transition-shadow hover:shadow-glow-arc"
            >
              RESET MATRIX
            </button>
          </div>
        )}

        <FilterPanel filters={filters} onChange={setFilters} booted={booted} />
        <NeuronTooltip memoryId={hoverId} containerRef={containerRef} />

        {/* cinematic dive into the cortical volume */}
        {webgl && booted && (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('realmemory:enter-brain'))}
            className="absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-md border border-panel-hot bg-[rgba(5,11,24,0.55)] px-4 py-1.5 font-display text-[10px] font-bold tracking-[0.24em] text-arc backdrop-blur-[10px] transition-shadow duration-300 hover:shadow-glow-arc"
          >
            ENTER BRAIN
          </button>
        )}

        {/* detail drawer */}
        <div className="absolute bottom-3 right-3 top-3 z-30">
          <NodeDetailDrawer memoryId={selectedId} onClose={() => setSelectedId(null)} onNavigate={navigateTo} />
        </div>

        {/* bottom bar: ticker + legend */}
        <motion.div
          initial={{ y: '100%' }}
          animate={booted ? { y: 0 } : {}}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
          className="absolute bottom-0 left-0 right-0 z-30 flex h-11 items-center gap-4 border-t border-panel-border bg-[rgba(5,11,24,0.6)] px-4 backdrop-blur-[14px]"
        >
          <EventTicker booted={booted} />
          <span className="micro-label hidden shrink-0 lg:block">SCROLL TO ENTER THE CORTEX</span>
          <LabelsToggle />
          <ColorModeToggle />
          <Legend />
        </motion.div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onPick={navigateTo} />
    </div>
  );
}
