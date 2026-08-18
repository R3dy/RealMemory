import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import HoloPanel from '@/components/HoloPanel';
import { useInView } from '@/components/brain/anim';
import { AXIS_TICK, GRID_PROPS, TooltipRow, TooltipShell, mergeSeries, metric } from './ChartTheme';
import { cn } from '@/lib/utils';

/**
 * ReflexActivity — health.md §4.
 * 30-day stacked bars: fire (cyan) / block (red) / rewrite (orange) / override
 * (amber). Legend LED dots isolate a series on click; summary column right.
 */

const SERIES = [
  { key: 'fire', name: 'reflex_fire', color: '#00d4ff' },
  { key: 'rewrite', name: 'reflex_rewrite', color: '#ff9f1c' },
  { key: 'block', name: 'reflex_block', color: '#ff3355' },
  { key: 'override', name: 'reflex_override', color: '#ffb627' },
] as const;

type SeriesKey = (typeof SERIES)[number]['key'];

function ReflexTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name?: string | number; value?: number | string; color?: string; dataKey?: string | number }[];
  label?: string;
}) {
  if (!active || !payload) return null;
  return (
    <TooltipShell label={label}>
      {payload.map((p) => (
        <TooltipRow key={String(p.dataKey)} color={p.color ?? '#00d4ff'} name={String(p.name)} value={p.value} />
      ))}
    </TooltipShell>
  );
}

export default function ReflexActivity() {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  const [isolated, setIsolated] = useState<SeriesKey | null>(null);
  const data = useMemo(
    () => mergeSeries(['reflex_fire', 'reflex_block', 'reflex_rewrite', 'reflex_override'], ['fire', 'block', 'rewrite', 'override']),
    [],
  );
  const totals = useMemo(
    () => ({
      blocks: Math.round(metric('reflex_block').sum),
      rewrites: Math.round(metric('reflex_rewrite').sum),
      overrides: Math.round(metric('reflex_override').sum),
    }),
    [],
  );

  return (
    <HoloPanel
      title="REFLEX ACTIVITY · 30D"
      className="h-full"
      headerRight={
        <div className="flex flex-wrap items-center gap-2">
          {SERIES.map((s) => {
            const active = isolated === null || isolated === s.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setIsolated((cur) => (cur === s.key ? null : s.key))}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2 py-[2px] font-mono text-[10px] transition-all duration-300',
                  active ? 'opacity-100' : 'opacity-40',
                )}
                style={{
                  color: s.color,
                  borderColor: isolated === s.key ? s.color : 'rgba(0,212,255,0.18)',
                  backgroundColor: isolated === s.key ? `${s.color}14` : 'transparent',
                }}
              >
                <span
                  className={cn('h-1.5 w-1.5 rounded-full', isolated === s.key && 'animate-led')}
                  style={{ backgroundColor: s.color, boxShadow: `0 0 5px ${s.color}` }}
                />
                {s.name.replace('reflex_', '')}
              </button>
            );
          })}
        </div>
      }
    >
      <div className="flex flex-col gap-4 p-3 lg:flex-row">
        <div ref={ref} className="h-[260px] min-w-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barCategoryGap="28%">
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={4} />
              <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} />
              <Tooltip content={<ReflexTooltip />} cursor={{ fill: 'rgba(0,212,255,0.05)' }} />
              {SERIES.map((s, i) => {
                const dimmed = isolated !== null && isolated !== s.key;
                return (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.name}
                    stackId="reflex"
                    fill={s.color}
                    fillOpacity={dimmed ? 0.15 : 0.85}
                    stroke={s.color}
                    strokeOpacity={dimmed ? 0.15 : 0.9}
                    strokeWidth={0.5}
                    isAnimationActive={inView}
                    animationDuration={600}
                    animationBegin={i * 40}
                    radius={s.key === 'override' ? [2, 2, 0, 0] : 0}
                    style={{ transition: 'opacity 300ms' }}
                  />
                );
              })}
            </BarChart>
          </ResponsiveContainer>
        </div>
        {/* summary column */}
        <div className="flex shrink-0 flex-row gap-6 border-t border-panel-border pt-3 lg:w-[150px] lg:flex-col lg:gap-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-1">
          <div>
            <div className="micro-label">Blocks</div>
            <div className="font-mono text-[20px] font-bold text-danger" style={{ textShadow: '0 0 10px rgba(255,51,85,.5)' }}>
              {totals.blocks}
            </div>
          </div>
          <div>
            <div className="micro-label">Rewrites</div>
            <div className="font-mono text-[20px] font-bold text-[#ff9f1c]" style={{ textShadow: '0 0 10px rgba(255,159,28,.5)' }}>
              {totals.rewrites}
            </div>
          </div>
          <div>
            <div className="micro-label">Overrides</div>
            <div className="font-mono text-[20px] font-bold text-reactor" style={{ textShadow: '0 0 10px rgba(255,182,39,.5)' }}>
              {totals.overrides}
            </div>
          </div>
          <p className="hidden font-mono text-[9.5px] leading-snug text-dim lg:block">
            override = human rejected a reflex — feeds back into rule weights
          </p>
        </div>
      </div>
    </HoloPanel>
  );
}
