import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { GraphFilters, Memory } from '@/lib/data';
import { MEMORIES, getGraph, getDomains } from '@/lib/data';
import HoloPanel from '@/components/HoloPanel';
import NodeDetailDrawer from '@/components/NodeDetailDrawer';
import FilterCommandBar, {
  EMPTY_INDEX_FILTERS,
  type IndexFilters,
} from '@/components/index-table/FilterCommandBar';
import MemoryTable, {
  sortMemories,
  type SortDir,
  type SortKey,
} from '@/components/index-table/MemoryTable';
import WeightHistogram, { type WeightBucket } from '@/components/index-table/WeightHistogram';
import { CountUp, DecodeText, useLenis } from '@/components/index-table/hud';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;

function StatChip({
  label,
  value,
  led,
  decimals = 0,
  delay = 0,
}: {
  label: string;
  value: number;
  led: string;
  decimals?: number;
  delay?: number;
}) {
  return (
    <motion.span
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.22, 1, 0.36, 1] }}
      className="holo-panel-ghost flex items-center gap-2 rounded-full border border-panel-border px-3 py-1.5 backdrop-blur-[14px]"
    >
      <span
        className="animate-led h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: led, boxShadow: `0 0 6px ${led}` }}
      />
      <span className="micro-label">{label}</span>
      <CountUp value={value} decimals={decimals} className="font-mono text-[13px] font-bold text-hi text-glow" />
    </motion.span>
  );
}

export default function Memories() {
  useLenis();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<IndexFilters>(EMPTY_INDEX_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>('weight');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlightBucket, setHighlightBucket] = useState<WeightBucket | null>(null);

  const domains = useMemo(() => getDomains(), []);
  const headerStats = useMemo(() => {
    const active = MEMORIES.filter((m) => m.status === 'active').length;
    const archived = MEMORIES.length - active;
    const avgConf = MEMORIES.reduce((s, m) => s + m.confidence, 0) / MEMORIES.length;
    return { active, archived, avgConf };
  }, []);

  // ---- filter → sort → paginate -------------------------------------------
  const filtered = useMemo(() => {
    const gf: GraphFilters = {
      q: filters.q || undefined,
      type: filters.types.size ? [...filters.types] : undefined,
      category: filters.categories.size ? [...filters.categories] : undefined,
      scope: filters.scope,
      domain: filters.domain ?? undefined,
      minWeight: filters.minWeight > 0 ? filters.minWeight : undefined,
      createdAfter: filters.createdAfter || undefined,
      createdBefore: filters.createdBefore ? `${filters.createdBefore}T23:59:59` : undefined,
    };
    return getGraph(gf).nodes;
  }, [filters]);

  const sorted = useMemo(() => sortMemories(filtered, sortKey, sortDir), [filtered, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [sorted, safePage],
  );

  const applyFilters = useCallback((f: IndexFilters) => {
    setFilters(f);
    setPage(0);
  }, []);

  const onSort = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      setSortDir(key === 'weight' || key === 'createdAt' || key === 'updatedAt' ? 'desc' : 'asc');
      return key;
    });
    setPage(0);
  }, []);

  // ---- drawer + prev/next ---------------------------------------------------
  const selectedIndex = useMemo(
    () => (selectedId ? sorted.findIndex((m) => m.id === selectedId) : -1),
    [selectedId, sorted],
  );
  const step = useCallback(
    (delta: number) => {
      if (sorted.length === 0) return;
      const next =
        selectedIndex === -1
          ? delta > 0
            ? 0
            : sorted.length - 1
          : (selectedIndex + delta + sorted.length) % sorted.length;
      setSelectedId(sorted[next].id);
    },
    [selectedIndex, sorted],
  );

  const focusInGraph = useCallback(
    (m: Memory) => {
      navigate(`/?focus=${encodeURIComponent(m.id)}`);
    },
    [navigate],
  );

  const resetFilters = useCallback(
    () => applyFilters({ ...EMPTY_INDEX_FILTERS, types: new Set(), categories: new Set() }),
    [applyFilters],
  );

  const pickBucket = useCallback(
    (min: number) => {
      applyFilters({
        ...filters,
        minWeight: filters.minWeight > 0 && Math.abs(filters.minWeight - min) < 1e-9 ? 0 : min,
      });
    },
    [filters, applyFilters],
  );

  const sortLabel = `${sortKey === 'createdAt' ? 'CREATED' : sortKey === 'updatedAt' ? 'UPDATED' : sortKey.toUpperCase()} ${sortDir === 'asc' ? '↑' : '↓'}`;

  return (
    <div className="relative min-h-full pb-10">
      {/* dim layer while drawer is open */}
      <AnimatePresence>
        {selectedId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setSelectedId(null)}
            className="fixed inset-0 top-[60px] z-30 bg-[rgba(2,6,14,0.2)]"
          />
        )}
      </AnimatePresence>

      {/* ---- SECTION 1+2 · sticky header + filter command bar ---- */}
      <div className="sticky top-[60px] z-30 border-b border-panel-border bg-[rgba(2,6,14,0.72)] backdrop-blur-[14px]">
        <div className="px-6 pt-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-display text-[26px] font-bold leading-none tracking-[0.14em] text-hi text-glow">
                <DecodeText text="MEMORY INDEX" />
              </h1>
              <motion.p
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
                className="micro-label mt-2"
              >
                <CountUp value={sorted.length} className="text-arc" /> ENGRAMS · SORTED BY {sortLabel}
              </motion.p>
            </div>
            <div className="flex items-center gap-2">
              <StatChip label="Active" value={headerStats.active} led="#22ff88" delay={0.2} />
              <StatChip label="Archived" value={headerStats.archived} led="#8a97ab" delay={0.26} />
              <StatChip label="Avg Confidence" value={headerStats.avgConf} led="#00d4ff" decimals={2} delay={0.32} />
            </div>
          </div>
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.6, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
            className="holo-divider mt-3 origin-left"
          />
        </div>
        <motion.div
          initial={{ y: -16, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="px-6 py-3"
        >
          <FilterCommandBar filters={filters} onChange={applyFilters} domains={domains} />
        </motion.div>
      </div>

      {/* ---- SECTION 3+4 · data table + weight distribution ---- */}
      <div className={cn('px-6 pt-4 transition-opacity duration-200', selectedId && 'opacity-80')}>
        <motion.div
          initial={{ clipPath: 'inset(0 0 100% 0)', opacity: 0 }}
          animate={{ clipPath: 'inset(0 0 0% 0)', opacity: 1 }}
          transition={{ duration: 0.45, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
        >
          <HoloPanel title="ENGRAM MATRIX" corners>
            <div className="max-h-[870px] overflow-y-auto">
              <MemoryTable
                rows={pageRows}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
                highlightBucket={highlightBucket}
                onOpen={(m) => setSelectedId(m.id)}
                onFocusInGraph={focusInGraph}
                onReset={resetFilters}
              />
            </div>

            <WeightHistogram
              rows={filtered}
              minWeight={filters.minWeight}
              onHoverBucket={setHighlightBucket}
              onPick={pickBucket}
            />

            {/* pagination */}
            <div className="flex items-center justify-between border-t border-panel-border px-4 py-2">
              <span className="font-mono text-[11px] text-dim">
                SHOWING{' '}
                <span className="text-hi">
                  {sorted.length === 0 ? 0 : safePage * PAGE_SIZE + 1}–
                  {Math.min(sorted.length, safePage * PAGE_SIZE + PAGE_SIZE)}
                </span>{' '}
                OF <span className="text-arc">{sorted.length}</span> ENGRAMS
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label="Previous page"
                  disabled={safePage === 0}
                  onClick={() => setPage(safePage - 1)}
                  className="text-dim transition-colors hover:text-arc disabled:opacity-30 disabled:hover:text-dim"
                >
                  <ChevronLeft size={15} />
                </button>
                <span className="font-mono text-[12px] font-bold text-hi">
                  {safePage + 1} / {pageCount}
                </span>
                <button
                  type="button"
                  aria-label="Next page"
                  disabled={safePage >= pageCount - 1}
                  onClick={() => setPage(safePage + 1)}
                  className="text-dim transition-colors hover:text-arc disabled:opacity-30 disabled:hover:text-dim"
                >
                  <ChevronRight size={15} />
                </button>
              </div>
              <span className="hidden font-mono text-[10px] text-dim md:inline">
                CLICK row → detail · ⌘CLICK → focus in graph
              </span>
            </div>
          </HoloPanel>
        </motion.div>
      </div>

      {/* ---- SECTION 5 · detail drawer (shared component + prev/next) ---- */}
      <div className="fixed bottom-0 right-0 top-[60px] z-40 flex">
        <NodeDetailDrawer
          memoryId={selectedId}
          onClose={() => setSelectedId(null)}
          onNavigate={setSelectedId}
          className="h-full"
        />
      </div>
      {selectedId && (
        <div className="fixed right-[46px] top-[71px] z-50 flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous engram"
            onClick={() => step(-1)}
            className="rounded border border-panel-border bg-[rgba(2,6,14,0.6)] p-1 text-dim transition-colors hover:border-panel-hot hover:text-arc"
          >
            <ChevronLeft size={13} />
          </button>
          <span className="min-w-[44px] text-center font-mono text-[10px] text-dim">
            {selectedIndex >= 0 ? selectedIndex + 1 : '–'} / {sorted.length}
          </span>
          <button
            type="button"
            aria-label="Next engram"
            onClick={() => step(1)}
            className="rounded border border-panel-border bg-[rgba(2,6,14,0.6)] p-1 text-dim transition-colors hover:border-panel-hot hover:text-arc"
          >
            <ChevronRight size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
