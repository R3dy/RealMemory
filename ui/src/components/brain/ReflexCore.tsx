import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import HoloPanel from '@/components/HoloPanel';
import { MEMORIES } from '@/lib/data';
import type { Memory } from '@/lib/data';
import { INHIBITION_COLORS, TYPE_COLORS, weightColor } from '@/lib/colors';
import type { InhibitionLevel } from '@/lib/colors';
import { hexA, tsNow } from './anim';
import { useBrainEventsByKind } from '@/lib/use-brain-stream';

/**
 * ReflexCore — brain.md §3.
 * In-RAM rule cache (weight ≥ 0.3 admitted) + inhibition engine with a live
 * fire log driven by real reflex.fire|rewrite|block|override events
 * (synthetic-self Phase 8) — no Math.random.
 */

const LEVELS: InhibitionLevel[] = ['off', 'warn', 'rewrite', 'block'];
const CURRENT_LEVEL: InhibitionLevel = 'warn';

type FireAction = 'FIRE' | 'WARN' | 'REWRITE' | 'BLOCK';

const ACTION_COLORS: Record<FireAction, string> = {
  FIRE: '#00d4ff',
  WARN: INHIBITION_COLORS.warn,
  REWRITE: INHIBITION_COLORS.rewrite,
  BLOCK: INHIBITION_COLORS.block,
};

const KIND_TO_ACTION: Record<string, FireAction> = {
  'reflex.fire': 'WARN',
  'reflex.rewrite': 'REWRITE',
  'reflex.block': 'BLOCK',
  'reflex.override': 'FIRE',
};

interface FireRow {
  id: number;
  ts: string;
  action: FireAction;
  text: string;
}

function ruleText(m: Memory): string {
  if (m.type === 'lesson_learned' && typeof m.metadata.lesson === 'string') return m.metadata.lesson;
  return m.content;
}

export default function ReflexCore() {
  const rules = useMemo(
    () =>
      MEMORIES.filter(
        (m) => (m.type === 'lesson_learned' || m.type === 'user_preference') && m.weight >= 0.3,
      ).sort((a, b) => b.weight - a.weight),
    [],
  );
  const [level, setLevel] = useState<InhibitionLevel>(CURRENT_LEVEL);
  const [fires, setFires] = useState<FireRow[]>([]);
  const seq = useRef(0);

  // Real event-driven: subscribe to reflex.fire/rewrite/block/override events.
  const reflexEvents = useBrainEventsByKind([
    'reflex.fire',
    'reflex.rewrite',
    'reflex.block',
    'reflex.override',
  ]);

  useEffect(() => {
    if (reflexEvents.length === 0) return;
    const latest = reflexEvents[reflexEvents.length - 1]!;
    const action = KIND_TO_ACTION[latest.kind] ?? 'FIRE';
    const tool = (latest.payload.tool as string) ?? 'unknown';
    const note = (latest.payload.note as string) ?? '';
    const id = ++seq.current;
    setFires((rows) =>
      [{ id, ts: tsNow(), action, text: `"${tool}" ${note ? '· ' + note : ''}` }, ...rows].slice(0, 7),
    );
  }, [reflexEvents]);

  return (
    <HoloPanel
      title="REFLEX CORE"
      className="h-full"
      headerRight={
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-ok">
          <span className="animate-led h-1.5 w-1.5 rounded-full bg-ok shadow-[0_0_6px_var(--ok)]" />
          ACTIVE · {rules.length} RULES CACHED
        </span>
      }
    >
      <div className="p-4">
        {/* inhibition level selector (display-only in prototype) */}
        <div className="mb-4">
          <div className="micro-label mb-1.5">Inhibition Level</div>
          <div className="flex overflow-hidden rounded-md border border-panel-border">
            {LEVELS.map((l) => {
              const active = level === l;
              const color = INHIBITION_COLORS[l];
              return (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLevel(l)}
                  className="relative flex-1 px-2 py-1.5 font-display text-[10px] font-bold tracking-[0.18em] transition-all duration-150"
                  style={{
                    color: active ? color : 'var(--text-dim)',
                    backgroundColor: active ? hexA(color, 0.12) : 'transparent',
                    boxShadow: active ? `inset 0 0 0 1px ${hexA(color, 0.6)}, 0 0 12px ${hexA(color, 0.25)}` : undefined,
                  }}
                >
                  {active && (
                    <motion.span
                      className="pointer-events-none absolute inset-0 rounded-sm border"
                      style={{ borderColor: color }}
                      animate={{ opacity: [1, 0.35, 1] }}
                      transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                    />
                  )}
                  {l.toUpperCase()}
                </button>
              );
            })}
          </div>
        </div>

        {/* rule cache table */}
        <div className="micro-label mb-1.5 flex justify-between">
          <span>Rule Cache</span>
          <span>admit: weight ≥ 0.30</span>
        </div>
        <div className="max-h-[216px] overflow-y-auto rounded-md border border-panel-border">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-[rgba(5,11,24,0.95)]">
              <tr className="font-display text-[9px] tracking-[0.18em] text-dim">
                <th className="px-2.5 py-1.5 font-bold">RULE</th>
                <th className="w-14 px-2 py-1.5 font-bold">W</th>
                <th className="w-10 px-2 py-1.5 font-bold">SRC</th>
                <th className="w-12 px-2 py-1.5 text-right font-bold">HITS</th>
              </tr>
            </thead>
            <tbody>
              {rules.slice(0, 12).map((m, i) => (
                <motion.tr
                  key={m.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05, duration: 0.3 }}
                  className="border-t border-[rgba(0,212,255,0.07)] transition-colors hover:bg-[rgba(0,212,255,0.04)]"
                >
                  <td className="max-w-0 px-2.5 py-1.5">
                    <span className="block truncate text-[13px] text-mid">{ruleText(m)}</span>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[12px] font-bold" style={{ color: weightColor(m.weight) }}>
                    {m.weight.toFixed(2)}
                  </td>
                  <td className="px-2 py-1.5">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      title={m.type}
                      style={{ backgroundColor: TYPE_COLORS[m.type], boxShadow: `0 0 6px ${TYPE_COLORS[m.type]}` }}
                    />
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-[12px] text-mid">{m.accessCount}</td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* fire log */}
        <div className="micro-label mb-1.5 mt-4 flex justify-between">
          <span>Fire Log</span>
          <span>reflex_fire|block|rewrite|override</span>
        </div>
        <div className="flex min-h-[150px] flex-col gap-1 rounded-md border border-panel-border bg-[rgba(2,6,14,0.5)] p-2">
          <AnimatePresence initial={false}>
            {fires.map((row) => {
              const color = ACTION_COLORS[row.action];
              return (
                <motion.div
                  key={row.id}
                  initial={{ x: 24, opacity: 0, backgroundColor: hexA(color, 0.18) }}
                  animate={{
                    x: row.action === 'BLOCK' ? [24, 0, -2, 2, -2, 0] : 0,
                    opacity: 1,
                    backgroundColor: hexA(color, 0),
                  }}
                  exit={{ opacity: 0 }}
                  transition={{
                    duration: 0.5,
                    x: row.action === 'BLOCK' ? { duration: 0.45, times: [0, 0.4, 0.55, 0.7, 0.85, 1] } : { duration: 0.3 },
                  }}
                  className="flex items-baseline gap-2 rounded px-1.5 py-1 font-mono text-[11px]"
                >
                  <span className="shrink-0 text-dim">{row.ts}</span>
                  <span className="shrink-0 font-bold" style={{ color, textShadow: `0 0 8px ${hexA(color, 0.6)}` }}>
                    ▸ {row.action}
                  </span>
                  <span className="min-w-0 truncate text-mid">{row.text}</span>
                </motion.div>
              );
            })}
          </AnimatePresence>
          {fires.length === 0 && (
            <span className="px-1.5 py-1 font-mono text-[11px] text-dim">listening for tool calls…</span>
          )}
        </div>
      </div>
    </HoloPanel>
  );
}
