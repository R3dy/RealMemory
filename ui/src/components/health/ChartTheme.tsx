import type { CSSProperties, ReactNode } from 'react';
import { getMetrics } from '@/lib/data';
import type { Metric } from '@/lib/data';

/**
 * Shared recharts skin for BRAIN HEALTH — health.md "Chart styling".
 * Dark grid, glowing strokes, holo tooltips, micro-font ticks.
 */

export const GRID_PROPS = {
  stroke: 'rgba(0,212,255,.07)',
  vertical: false,
  strokeDasharray: undefined,
} as const;

export const AXIS_TICK = {
  fill: '#4b5f7c',
  fontSize: 10,
  fontFamily: 'Orbitron, sans-serif',
  letterSpacing: '0.12em',
} as const;

export function glow(color: string, blur = 6): CSSProperties {
  return { filter: `drop-shadow(0 0 ${blur}px ${color})` };
}

/** Mini holo-panel tooltip shell (glass + corner brackets + mono rows). */
export function TooltipShell({ label, children }: { label?: ReactNode; children: ReactNode }) {
  return (
    <div className="holo-panel holo-corners min-w-[150px] px-3 py-2 font-mono text-[11px]">
      {label !== undefined && (
        <div className="mb-1 border-b border-panel-border pb-1 text-[10px] text-dim">{label}</div>
      )}
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

export function TooltipRow({
  color,
  name,
  value,
}: {
  color: string;
  name: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 5px ${color}` }} />
      <span className="text-mid">{name}</span>
      <span className="ml-auto pl-3 font-bold" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

/** Convenience: first metric by name (always present in the mock layer). */
export function metric(name: string): Metric {
  return getMetrics(name)[0];
}

/** Merge several 30-day series into recharts rows keyed by date. */
export function mergeSeries(names: string[], keys?: string[]): Record<string, number | string>[] {
  const first = metric(names[0]);
  return first.series.map((p, i) => {
    const row: Record<string, number | string> = { date: p.date.slice(5), full: p.date };
    names.forEach((n, k) => {
      row[keys?.[k] ?? n] = metric(n).series[i]?.value ?? 0;
    });
    return row;
  });
}

/** 7-day delta: compare last-7 sum/avg vs previous-7. */
export function weekDelta(m: Metric, mode: 'sum' | 'avg' = 'sum'): number {
  const s = m.series;
  const last = s.slice(-7);
  const prev = s.slice(-14, -7);
  const agg = (arr: { value: number }[]) => arr.reduce((a, p) => a + p.value, 0) / (mode === 'avg' ? arr.length : 1);
  const l = agg(last);
  const p = agg(prev);
  return p === 0 ? 0 : ((l - p) / p) * 100;
}
