import { useMemo } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import HoloPanel from '@/components/HoloPanel';
import { useInView } from '@/components/brain/anim';
import { AXIS_TICK, GRID_PROPS, TooltipRow, TooltipShell, metric } from './ChartTheme';

/**
 * WorkingArousal — health.md §6.
 * A: SLOT UTILIZATION — 30d multi-line, one line per working-memory slot
 *    (token fill %), 90% amber dashed threshold with marching ants.
 * B: AROUSAL MODULATION — arousal band + implied temperature multiplier line.
 */

const SLOTS = [
  { key: 'identity', metric: 'working_memory:goal', color: '#00d4ff' },
  { key: 'taskFrame', metric: 'working_memory:plan', color: '#4da6ff' },
  { key: 'activeLessons', metric: 'working_memory:facts', color: '#ff3355' },
  { key: 'openPredictions', metric: 'working_memory:scratch', color: '#b26bff' },
] as const;

interface TEntry {
  name?: string | number;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
}

function GenericTooltip({
  active,
  payload,
  label,
  suffix = '',
}: {
  active?: boolean;
  payload?: TEntry[];
  label?: string;
  suffix?: string;
}) {
  if (!active || !payload) return null;
  return (
    <TooltipShell label={label}>
      {payload.map((p) => (
        <TooltipRow
          key={String(p.dataKey)}
          color={p.color ?? '#00d4ff'}
          name={String(p.name)}
          value={`${typeof p.value === 'number' ? p.value.toFixed(1) : p.value}${suffix}`}
        />
      ))}
    </TooltipShell>
  );
}

export function SlotUtilizationChart() {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  const data = useMemo(() => {
    const first = metric(SLOTS[0].metric);
    return first.series.map((p, i) => {
      const row: Record<string, number | string> = { date: p.date.slice(5) };
      for (const s of SLOTS) row[s.key] = Math.round((metric(s.metric).series[i]?.value ?? 0) * 1000) / 10;
      return row;
    });
  }, []);

  return (
    <HoloPanel
      title="WORKING MEMORY · SLOT UTILIZATION"
      className="h-full"
      headerRight={<span className="micro-label">token fill % · 30d</span>}
    >
      <div ref={ref} className="h-[230px] p-3">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={4} />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} domain={[0, 100]} unit="%" />
            <Tooltip content={<GenericTooltip suffix="%" />} cursor={{ stroke: 'rgba(0,212,255,0.35)' }} />
            <ReferenceLine
              y={90}
              stroke="#ffb627"
              strokeWidth={1.2}
              strokeDasharray="6 4"
              style={{ animation: 'dash-flow 8s linear infinite' }}
              label={{ value: '90%', position: 'insideTopRight', fill: '#ffb627', fontSize: 9, fontFamily: 'Orbitron, sans-serif' }}
            />
            {SLOTS.map((s, i) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.key}
                stroke={s.color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={inView}
                animationDuration={900}
                animationBegin={i * 150}
                style={{ filter: `drop-shadow(0 0 5px ${s.color})` }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </HoloPanel>
  );
}

export function ArousalChart() {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  const data = useMemo(
    () =>
      metric('arousal_modulation').series.map((p) => ({
        date: p.date.slice(5),
        arousal: Math.round(p.value * 1000) / 1000,
        temp: Math.round((1 - 0.2 * p.value) * 1000) / 1000,
      })),
    [],
  );

  return (
    <HoloPanel
      title="AROUSAL MODULATION · 30D"
      className="h-full"
      headerRight={<span className="micro-label">temp = 1 − 0.2·arousal</span>}
    >
      <div ref={ref} className="h-[230px] p-3">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: -6, bottom: 0, left: -24 }}>
            <defs>
              <linearGradient id="arousalFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ffb627" stopOpacity={0.22} />
                <stop offset="100%" stopColor="#ffb627" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={4} />
            <YAxis yAxisId="a" tick={AXIS_TICK} tickLine={false} axisLine={false} domain={[0, 1]} />
            <YAxis
              yAxisId="t"
              orientation="right"
              tick={{ ...AXIS_TICK, fill: '#ffb627' }}
              tickLine={false}
              axisLine={false}
              domain={[0.8, 1]}
              tickFormatter={(v: number) => `×${v.toFixed(2)}`}
            />
            <Tooltip content={<GenericTooltip />} cursor={{ stroke: 'rgba(255,182,39,0.35)' }} />
            <Area
              yAxisId="a"
              type="monotone"
              dataKey="arousal"
              name="arousal"
              stroke="#ffb627"
              strokeWidth={2}
              fill="url(#arousalFill)"
              isAnimationActive={inView}
              animationDuration={900}
              style={{ filter: 'drop-shadow(0 0 6px rgba(255,182,39,0.5))' }}
            />
            <Line
              yAxisId="t"
              type="monotone"
              dataKey="temp"
              name="temp ×"
              stroke="#7de9ff"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={inView}
              animationDuration={900}
              animationBegin={300}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </HoloPanel>
  );
}
