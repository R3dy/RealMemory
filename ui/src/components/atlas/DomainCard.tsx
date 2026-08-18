import { memo } from 'react';
import { motion } from 'framer-motion';
import { Crosshair, MoveRight } from 'lucide-react';
import type { MemoryType } from '@/lib/data';
import { TYPE_COLORS, weightColor } from '@/lib/colors';
import SynapseTag from '@/components/SynapseTag';
import MiniConstellation from './MiniConstellation';
import { CountUp } from '@/components/index-table/hud';
import type { DomainStats } from './domain-stats';
import { cn } from '@/lib/utils';

const TYPE_ORDER: MemoryType[] = [
  'codebase_fact',
  'task_pattern',
  'lesson_learned',
  'user_preference',
  'session_summary',
  'contextual_note',
];

/**
 * DomainCard — domains.md §2. Holographic sector card with live
 * mini-constellation, type/weight breakdown and FOCUS SECTOR deep-link.
 */
export default memo(function DomainCard({
  stats,
  index,
  onFocus,
}: {
  stats: DomainStats;
  index: number;
  onFocus: (domain: string) => void;
}) {
  const sparse = stats.count < 3;
  const presentTypes = TYPE_ORDER.filter((t) => (stats.typeCounts[t] ?? 0) > 0);

  return (
    <motion.article
      layout="position"
      initial={{ clipPath: 'inset(0 100% 0 0)', opacity: 0, y: 24 }}
      animate={{ clipPath: 'inset(0 0% 0 0)', opacity: 1, y: 0 }}
      transition={{
        duration: 0.5,
        delay: index * 0.08,
        ease: [0.22, 1, 0.36, 1],
        layout: { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
      }}
      whileHover={{ y: -4 }}
      className="holo-panel holo-corners group relative flex min-h-[340px] flex-col p-4 transition-[border-color,box-shadow] duration-200 hover:border-panel-hot hover:shadow-glow-arc"
    >
      {/* header: name + count + activity LED */}
      <div className="relative z-10 flex items-baseline gap-3">
        <h2 className="font-display text-[20px] font-bold tracking-[0.14em] text-hi">
          {stats.name.toUpperCase()}
        </h2>
        <CountUp
          value={stats.count}
          className="ml-auto font-mono text-[24px] font-bold leading-none text-arc text-glow"
        />
        <span
          className={cn('h-2 w-2 rounded-full', stats.activeRecently && 'animate-led')}
          style={{
            backgroundColor: stats.activeRecently ? 'var(--ok)' : 'var(--text-dim)',
            boxShadow: stats.activeRecently ? '0 0 8px var(--ok)' : undefined,
          }}
          title={stats.activeRecently ? 'active in the last 24h' : 'no recent activity'}
        />
      </div>

      {/* top categories */}
      <div className="relative z-10 mt-2 flex flex-wrap gap-1.5">
        {stats.topCategories.map((c) => (
          <SynapseTag key={c} label={c} color="#ffb627" dot={false} />
        ))}
      </div>

      {/* body: constellation + breakdowns */}
      <div className="relative z-10 mt-3 flex min-h-0 flex-1 gap-3">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.3 + index * 0.08 }}
          className="flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-[rgba(0,212,255,0.1)] bg-[rgba(2,6,14,0.45)]"
        >
          {sparse ? (
            <span className="micro-label flex items-center justify-center" style={{ width: 220, height: 180 }}>
              SPARSE SECTOR
            </span>
          ) : (
            <MiniConstellation domain={stats.name} nodes={stats.nodes} edges={stats.edges} width={220} height={180} />
          )}
        </motion.div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="micro-label mb-1.5">Types</div>
          {/* stacked bar */}
          <div className="flex h-2.5 w-full gap-[1px] overflow-hidden rounded-full">
            {presentTypes.map((t, i) => (
              <motion.span
                key={t}
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.5, delay: 0.3 + index * 0.08 + i * 0.05, ease: [0.22, 1, 0.36, 1] }}
                className="block h-full origin-left"
                style={{
                  width: `${((stats.typeCounts[t] ?? 0) / stats.count) * 100}%`,
                  backgroundColor: TYPE_COLORS[t],
                  boxShadow: `0 0 6px ${TYPE_COLORS[t]}66`,
                }}
                title={`${t} · ${stats.typeCounts[t]}`}
              />
            ))}
          </div>
          {/* legend rows */}
          <div className="mt-2 space-y-1">
            {presentTypes.slice(0, 4).map((t) => (
              <div key={t} className="flex items-center gap-2 text-[12px]">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: TYPE_COLORS[t], boxShadow: `0 0 4px ${TYPE_COLORS[t]}` }}
                />
                <span className="truncate font-mono text-[10.5px] uppercase tracking-wide text-mid">
                  {t.replace('_', ' ')}
                </span>
                <span className="ml-auto font-mono text-[11px] font-bold text-hi">
                  {stats.typeCounts[t]}
                </span>
              </div>
            ))}
          </div>
          {/* avg weight */}
          <div className="mt-auto flex items-center justify-between border-t border-[rgba(0,212,255,0.08)] pt-2">
            <span className="micro-label">Avg Weight</span>
            <span
              className="font-mono text-[16px] font-bold text-glow"
              style={{ color: weightColor(stats.avgWeight) }}
            >
              {stats.avgWeight.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* top tags */}
      <div className="relative z-10 mt-3 flex flex-wrap gap-1.5">
        {stats.topTags.map((t) => (
          <span
            key={t}
            className="rounded border border-panel-border bg-[rgba(0,212,255,0.06)] px-1.5 py-[1px] font-mono text-[10px] text-mid"
          >
            #{t}
          </span>
        ))}
      </div>

      {/* footer: tier chips + CTA */}
      <div className="relative z-10 mt-3 flex items-center gap-2 border-t border-panel-border pt-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] font-bold">
          <span style={{ color: '#22ff88' }}>STRONG {stats.tiers.strong}</span>
          <span className="text-dim">·</span>
          <span style={{ color: '#ffd319' }}>STABLE {stats.tiers.stable}</span>
          <span className="text-dim">·</span>
          <span style={{ color: '#ff3355' }}>FADING {stats.tiers.fading}</span>
        </div>
        <button
          type="button"
          onClick={() => onFocus(stats.name)}
          className="group/cta ml-auto flex items-center gap-1.5 rounded-md border border-[rgba(0,212,255,0.45)] bg-[rgba(0,212,255,0.06)] px-3 py-1.5 font-display text-[10px] font-bold tracking-[0.16em] text-arc transition-all duration-200 hover:border-panel-hot hover:bg-[rgba(0,212,255,0.16)] hover:shadow-glow-arc"
        >
          <Crosshair size={12} />
          FOCUS SECTOR
          <MoveRight size={13} className="transition-transform duration-200 group-hover/cta:translate-x-1" />
        </button>
      </div>
    </motion.article>
  );
});
