import { useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import HoloPanel from '@/components/HoloPanel';
import { MEMORIES } from '@/lib/data';
import { CountUp, useInView } from '@/components/brain/anim';
import { AXIS_TICK, GRID_PROPS, TooltipRow, TooltipShell, metric } from './ChartTheme';
import { cn } from '@/lib/utils';

/**
 * GrowthChart — health.md §7.
 * Dual-axis combo: bars = total active memories per day (cyan, left);
 * line = cumulative schema_formation (violet, right) with star markers on
 * formation days; memory_bloat_ratio toggleable amber overlay (off default).
 */

const DAY = 86_400_000;

function starPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`);
  }
  return pts.join(' ');
}

interface DotProps {
  cx?: number;
  cy?: number;
  payload?: { formation?: boolean };
}

function StarDot({ cx, cy, payload }: DotProps) {
  if (!payload?.formation || cx === undefined || cy === undefined) return null;
  return (
    <polygon
      points={starPoints(cx, cy, 5)}
      fill="#b26bff"
      stroke="#e8f6ff"
      strokeWidth={0.6}
      style={{ filter: 'drop-shadow(0 0 6px #b26bff)' }}
    />
  );
}

export default function GrowthChart() {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  const [showBloat, setShowBloat] = useState(false);

  const data = useMemo(() => {
    const schema = metric('schema_formation');
    const bloat = metric('memory_bloat_ratio');
    const endOfDay = (date: string) => new Date(date).getTime() + DAY;
    let cum = 0;
    return schema.series.map((p, i) => {
      cum += p.value;
      const active = MEMORIES.filter(
        (m) => m.status === 'active' && new Date(m.createdAt).getTime() <= endOfDay(p.date),
      ).length;
      return {
        date: p.date.slice(5),
        memories: active,
        schemas: Math.round(cum),
        formation: p.value >= 2,
        bloat: Math.round((bloat.series[i]?.value ?? 0) * 1000) / 10,
      };
    });
  }, []);

  const dupAvg = metric('duplicate_rate').avg;
  const bloatLatest = metric('memory_bloat_ratio').latest;

  return (
    <HoloPanel
      title="GROWTH & CONSOLIDATION · 30D"
      className="h-full"
      headerRight={
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-arc">
            <span className="h-2 w-2 rounded-[1px] bg-arc opacity-80" /> memories
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-[#b26bff]">
            <span className="h-[2px] w-3 bg-[#b26bff]" /> schemas
          </span>
          <button
            type="button"
            onClick={() => setShowBloat((b) => !b)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-2 py-[1px] font-mono text-[10px] transition-all duration-300',
              showBloat ? 'border-[#ffb627] text-reactor' : 'border-panel-border text-dim hover:text-reactor',
            )}
          >
            <span className={cn('h-[2px] w-3', showBloat ? 'bg-reactor' : 'bg-dim')} />
            bloat {showBloat ? 'on' : 'off'}
          </button>
        </div>
      }
    >
      <div ref={ref} className="h-[260px] p-3">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: -6, bottom: 0, left: -14 }}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={4} />
            <YAxis yAxisId="m" tick={AXIS_TICK} tickLine={false} axisLine={false} domain={['dataMin - 8', 'dataMax + 4']} />
            <YAxis yAxisId="s" orientation="right" tick={{ ...AXIS_TICK, fill: '#b26bff' }} tickLine={false} axisLine={false} />
            {showBloat && (
              <YAxis yAxisId="b" hide domain={[0, 40]} />
            )}
            <Tooltip
              cursor={{ fill: 'rgba(0,212,255,0.05)' }}
              content={({ active, payload, label }) => {
                if (!active || !payload) return null;
                return (
                  <TooltipShell label={label}>
                    {payload.map((p) => (
                      <TooltipRow
                        key={String(p.dataKey)}
                        color={(p.color as string) ?? '#00d4ff'}
                        name={String(p.name)}
                        value={p.dataKey === 'bloat' ? `${p.value}%` : p.value}
                      />
                    ))}
                  </TooltipShell>
                );
              }}
            />
            <Bar yAxisId="m" dataKey="memories" name="memories" isAnimationActive={inView} animationDuration={600} barSize={10}>
              {data.map((d) => (
                <Cell key={d.date} fill="#00d4ff" fillOpacity={d.formation ? 0.9 : 0.45} />
              ))}
            </Bar>
            <Line
              yAxisId="s"
              type="stepAfter"
              dataKey="schemas"
              name="schemas (cum)"
              stroke="#b26bff"
              strokeWidth={2}
              dot={<StarDot />}
              isAnimationActive={inView}
              animationDuration={1000}
              style={{ filter: 'drop-shadow(0 0 5px rgba(178,107,255,0.6))' }}
            />
            {showBloat && (
              <Line
                yAxisId="b"
                type="monotone"
                dataKey="bloat"
                name="bloat"
                stroke="#ffb627"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={false}
                isAnimationActive={inView}
                style={{ filter: 'drop-shadow(0 0 5px rgba(255,182,39,0.5))' }}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="holo-divider mx-3" />
      <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2.5 font-mono text-[10.5px]">
        <span className="text-mid">
          DUPLICATE RATE <CountUp value={dupAvg * 100} decimals={1} className="font-bold text-reactor" />%
        </span>
        <span className="text-mid">
          BLOAT <span className="font-bold text-reactor">{bloatLatest.toFixed(2)}</span>
        </span>
        <span className="text-mid">
          ARCHIVED THIS WEEK <span className="font-bold text-danger">4</span>
        </span>
        <span className="ml-auto text-dim">star = schema formation event</span>
      </div>
    </HoloPanel>
  );
}
