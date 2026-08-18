import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import HoloPanel from '@/components/HoloPanel';
import { useInView } from '@/components/brain/anim';
import { AXIS_TICK, GRID_PROPS, TooltipRow, TooltipShell, mergeSeries, metric } from './ChartTheme';

/**
 * RecallCharts — health.md §3.
 * A: RECALL SIGNAL — 30d area, recall_hit (cyan) + recall_miss (red).
 * B: PREDICTION ERROR — 30d stacked area low/med/high with surprise-spike marker.
 */

interface TooltipEntry {
  name?: string | number;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
}

function RecallTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const hits = Number(payload.find((p) => p.dataKey === 'hits')?.value ?? 0);
  const misses = Number(payload.find((p) => p.dataKey === 'misses')?.value ?? 0);
  const acc = hits + misses === 0 ? 0 : Math.round((hits / (hits + misses)) * 100);
  return (
    <TooltipShell label={label}>
      <TooltipRow color="#00d4ff" name="hits" value={hits} />
      <TooltipRow color="#ff3355" name="misses" value={misses} />
      <TooltipRow color="#22ff88" name="acc" value={`${acc}%`} />
    </TooltipShell>
  );
}

function ErrorTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
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

export function RecallSignalChart() {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  const data = useMemo(() => mergeSeries(['recall_hit', 'recall_miss'], ['hits', 'misses']), []);

  return (
    <HoloPanel title="RECALL SIGNAL · 30D" className="h-full" headerRight={<span className="micro-label">recall_hit|miss</span>}>
      <div ref={ref} className="h-[240px] p-3">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
            <defs>
              <linearGradient id="hitFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#00d4ff" stopOpacity={0.22} />
                <stop offset="100%" stopColor="#00d4ff" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="missFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ff3355" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#ff3355" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={4} />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} />
            <Tooltip content={<RecallTooltip />} cursor={{ stroke: 'rgba(0,212,255,0.35)', strokeWidth: 1 }} />
            <Area
              type="monotone"
              dataKey="hits"
              name="hits"
              stroke="#00d4ff"
              strokeWidth={2}
              fill="url(#hitFill)"
              isAnimationActive={inView}
              animationDuration={900}
              style={{ filter: 'drop-shadow(0 0 6px rgba(0,212,255,0.55))' }}
            />
            <Area
              type="monotone"
              dataKey="misses"
              name="misses"
              stroke="#ff3355"
              strokeWidth={2}
              fill="url(#missFill)"
              isAnimationActive={inView}
              animationDuration={900}
              style={{ filter: 'drop-shadow(0 0 6px rgba(255,51,85,0.55))' }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </HoloPanel>
  );
}

export function PredictionErrorChart() {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  const data = useMemo(
    () => mergeSeries(['prediction_error:low', 'prediction_error:med', 'prediction_error:high'], ['low', 'med', 'high']),
    [],
  );
  const spike = useMemo(() => {
    let best = 0;
    let idx = 0;
    metric('prediction_error:high').series.forEach((p, i) => {
      if (p.value > best) {
        best = p.value;
        idx = i;
      }
    });
    return { date: data[idx]?.date as string, value: best };
  }, [data]);

  return (
    <HoloPanel
      title="PREDICTION ERROR · 30D"
      className="h-full"
      headerRight={<span className="micro-label">low|med|high stacked</span>}
    >
      <div ref={ref} className="h-[240px] p-3">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
            <defs>
              {(['low', 'med', 'high'] as const).map((k) => (
                <linearGradient key={k} id={`err-${k}`} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor={k === 'low' ? '#22ff88' : k === 'med' ? '#ffd319' : '#ff3355'}
                    stopOpacity={0.28}
                  />
                  <stop
                    offset="100%"
                    stopColor={k === 'low' ? '#22ff88' : k === 'med' ? '#ffd319' : '#ff3355'}
                    stopOpacity={0.03}
                  />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={4} />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} />
            <Tooltip content={<ErrorTooltip />} cursor={{ stroke: 'rgba(0,212,255,0.35)', strokeWidth: 1 }} />
            <Area type="monotone" dataKey="low" stackId="1" stroke="#22ff88" strokeWidth={1.5} fill="url(#err-low)" isAnimationActive={inView} animationDuration={900} />
            <Area type="monotone" dataKey="med" stackId="1" stroke="#ffd319" strokeWidth={1.5} fill="url(#err-med)" isAnimationActive={inView} animationDuration={900} />
            <Area
              type="monotone"
              dataKey="high"
              stackId="1"
              stroke="#ff3355"
              strokeWidth={2}
              fill="url(#err-high)"
              isAnimationActive={inView}
              animationDuration={900}
              style={{ filter: 'drop-shadow(0 0 6px rgba(255,51,85,0.5))' }}
            />
            {inView && (
              <ReferenceDot
                x={spike.date}
                y={spike.value + (metric('prediction_error:med').series.find((s) => s.date.slice(5) === spike.date)?.value ?? 0) + (metric('prediction_error:low').series.find((s) => s.date.slice(5) === spike.date)?.value ?? 0)}
                r={5}
                fill="#ff3355"
                stroke="#ff3355"
                style={{ filter: 'drop-shadow(0 0 8px #ff3355)', animation: 'led-blink 1.6s ease-in-out infinite' }}
                label={{
                  value: 'SURPRISE SPIKE · 3 lessons encoded',
                  position: 'top',
                  fill: '#ff3355',
                  fontSize: 9,
                  fontFamily: 'Orbitron, sans-serif',
                  fontWeight: 700,
                }}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </HoloPanel>
  );
}
