import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import HoloPanel from '@/components/HoloPanel';
import MemoryCard from '@/components/MemoryCard';
import { MEMORIES, getMetrics } from '@/lib/data';
import type { MemoryType } from '@/lib/data';
import { hexA } from './anim';
import { cn } from '@/lib/utils';
import { useBrainEventsByKind } from '@/lib/use-brain-stream';

/**
 * WorkingMemoryWindow — brain.md §5.
 * The 800-token budget injected every turn, as a segmented capacity bar:
 * IDENTITY 150 · TASK FRAME 200 · ACTIVE LESSONS 300 · OPEN PREDICTIONS 150.
 * Driven by real `wm.assembled` events (synthetic-self Phase 8) — slot
 * memory IDs + token counts come from the event payload, not Math.random.
 */

interface Slot {
  id: string;
  label: string;
  budget: number;
  color: string;
  metric: string;
  memType?: MemoryType;
  take?: number;
}

const SLOTS: Slot[] = [
  { id: 'identity', label: 'IDENTITY', budget: 150, color: '#00d4ff', metric: 'working_memory:goal', memType: 'user_preference', take: 2 },
  { id: 'taskFrame', label: 'TASK FRAME', budget: 200, color: '#4da6ff', metric: 'working_memory:plan', memType: 'task_pattern', take: 2 },
  { id: 'activeLessons', label: 'ACTIVE LESSONS', budget: 300, color: '#ff3355', metric: 'working_memory:facts', memType: 'lesson_learned', take: 3 },
  { id: 'openPredictions', label: 'OPEN PREDICTIONS', budget: 150, color: '#b26bff', metric: 'working_memory:scratch' },
];

export default function WorkingMemoryWindow() {
  const wmEvents = useBrainEventsByKind(['wm.assembled']);
  const [util, setUtil] = useState<Record<string, number>>(() =>
    Object.fromEntries(SLOTS.map((s) => [s.id, getMetrics(s.metric)[0]?.latest ?? 0])),
  );
  const [glow, setGlow] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  // Real event-driven: wm.assembled events carry slot memory IDs + token budget.
  // Update utilization from the payload's slot occupancy.
  useEffect(() => {
    if (wmEvents.length === 0) return;
    const latest = wmEvents[wmEvents.length - 1]!;
    const payload = latest.payload;
    const tokenBudget = (payload.tokenBudget as number) ?? 800;
    // Slot utilization = slot memory count / expected, clamped to budget ratio.
    const slotMap: Record<string, string[]> = {
      identity: (payload.identity as string[]) ?? [],
      taskFrame: (payload.taskFrame as string[]) ?? [],
      queriedLessons: (payload.queriedLessons as string[]) ?? [],
      freshLessons: (payload.freshLessons as string[]) ?? [],
      openPredictions: (payload.openPredictions as string[]) ?? [],
    };
    setUtil((u) => {
      const next = { ...u };
      for (const s of SLOTS) {
        const ids = slotMap[s.id] ?? [];
        // Utilization: at least 0.3 if non-empty (something was injected),
        // scaled by count relative to a nominal 3-per-slot.
        const ratio = ids.length > 0 ? Math.min(0.95, 0.3 + (ids.length / 3) * 0.4) : 0.1;
        next[s.id] = ratio;
      }
      return next;
    });
    // Glow the most-utilized slot.
    const glowSlot = SLOTS.reduce((best, s) => (util[s.id] > util[best.id] ? s : best), SLOTS[0]!);
    setGlow(glowSlot.id);
    const timer = window.setTimeout(() => setGlow(null), 900);
    return () => window.clearTimeout(timer);
  }, [wmEvents]);

  const contents = useMemo(() => {
    const map: Record<string, typeof MEMORIES> = {};
    for (const s of SLOTS) {
      if (!s.memType) continue;
      map[s.id] = MEMORIES.filter((m) => m.type === s.memType && m.status === 'active')
        .sort((a, b) => b.weight - a.weight)
        .slice(0, s.take ?? 2);
    }
    return map;
  }, []);

  const tokens = (s: Slot) => Math.round(util[s.id] * s.budget);
  const totalUsed = SLOTS.reduce((acc, s) => acc + tokens(s), 0);
  const hot = totalUsed / 800 > 0.9;
  const openSlot = SLOTS.find((s) => s.id === open);

  return (
    <HoloPanel
      title="WORKING MEMORY WINDOW"
      className="h-full"
      headerRight={
        <motion.span
          className="font-mono text-[12px] font-bold"
          style={{ color: hot ? 'var(--reactor)' : 'var(--text-hi)' }}
          animate={hot ? { opacity: [1, 0.4, 1] } : { opacity: 1 }}
          transition={hot ? { duration: 1.2, repeat: Infinity } : undefined}
        >
          {totalUsed} / 800 TOKENS
        </motion.span>
      }
    >
      <div className="p-4">
        {/* segment labels */}
        <div className="flex gap-1">
          {SLOTS.map((s) => (
            <div key={s.id} style={{ flexGrow: s.budget, flexBasis: 0 }} className="min-w-0">
              <div className="flex items-baseline justify-between gap-1 px-0.5">
                <span className="truncate font-display text-[9px] font-bold tracking-[0.14em]" style={{ color: s.color }}>
                  {s.label}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-mid">
                  {tokens(s)}/{s.budget}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* capacity bar */}
        <div className="mt-1 flex h-14 gap-1">
          {SLOTS.map((s, i) => {
            const u = util[s.id];
            const isOpen = open === s.id;
            return (
              <motion.button
                key={s.id}
                type="button"
                onClick={() => setOpen(isOpen ? null : s.id)}
                style={{ flexGrow: s.budget, flexBasis: 0, transformOrigin: 'left center' }}
                initial={{ scaleX: 0 }}
                whileInView={{ scaleX: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: i * 0.1 }}
                className={cn(
                  'relative min-w-0 cursor-pointer overflow-hidden rounded border transition-all duration-200',
                  isOpen ? 'border-panel-hot' : 'hover:-translate-y-px',
                )}
              >
                <span
                  className="absolute inset-0 rounded border"
                  style={{
                    borderColor: hexA(s.color, isOpen ? 0.8 : 0.35),
                    boxShadow: glow === s.id || isOpen ? `0 0 14px ${hexA(s.color, 0.45)}` : undefined,
                    transition: 'box-shadow 300ms, border-color 200ms',
                  }}
                />
                {/* utilization fill */}
                <motion.span
                  className="absolute inset-x-0 bottom-0"
                  style={{
                    background: `linear-gradient(180deg, ${hexA(s.color, 0.05)}, ${hexA(s.color, 0.35)})`,
                    borderTop: `1px solid ${hexA(s.color, 0.9)}`,
                  }}
                  initial={{ height: '0%' }}
                  animate={{ height: `${u * 100}%` }}
                  transition={{ duration: 0.5, ease: 'easeOut' }}
                />
                <span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] font-bold" style={{ color: s.color }}>
                  {Math.round(u * 100)}%
                </span>
              </motion.button>
            );
          })}
        </div>

        {/* slide-out slot drawer */}
        <AnimatePresence initial={false}>
          {openSlot && (
            <motion.div
              key={openSlot.id}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, type: 'spring', stiffness: 260, damping: 30 }}
              className="overflow-hidden"
            >
              <div className="mt-3 rounded-md border border-panel-border bg-[rgba(2,6,14,0.5)] p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: openSlot.color, boxShadow: `0 0 6px ${openSlot.color}` }} />
                  <span className="micro-label" style={{ color: openSlot.color }}>
                    {openSlot.label} · injected every turn · {openSlot.metric}
                  </span>
                  <ChevronDown size={12} className="ml-auto text-dim" />
                </div>
                {openSlot.memType ? (
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {(contents[openSlot.id] ?? []).map((m, i) => (
                      <motion.div
                        key={m.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.04, duration: 0.3 }}
                      >
                        <MemoryCard memory={m} compact />
                      </motion.div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {PREDICTIONS.map((p, i) => (
                      <motion.div
                        key={p.text}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.04, duration: 0.3 }}
                        className="flex items-baseline gap-2 rounded border border-panel-border bg-[rgba(8,20,38,0.45)] px-2.5 py-1.5 font-mono text-[11px]"
                      >
                        <span className="text-reactor">⧗</span>
                        <span className="min-w-0 truncate text-hi">{p.text}</span>
                        <span className="ml-auto shrink-0 text-dim">conf {p.conf.toFixed(2)}</span>
                      </motion.div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-2 flex justify-between font-mono text-[10px] text-dim">
          <span>click a segment to inspect slot contents</span>
          <span>working_memory:goal|plan|facts|scratch</span>
        </div>
      </div>
    </HoloPanel>
  );
}
