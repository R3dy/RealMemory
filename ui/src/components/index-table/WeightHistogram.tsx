import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import type { Memory } from '@/lib/data';
import { weightColor, ARCHIVE_THRESHOLD } from '@/lib/colors';
import { cn } from '@/lib/utils';

export interface WeightBucket {
  index: number;
  min: number;
  max: number;
  count: number;
}

const BUCKETS = 20; // 0..1 in 0.05 steps

/**
 * WeightHistogram — memories.md §4.
 * 100%-wide 48px histogram strip; x = weight 0→1, bars = counts per 0.05 bucket,
 * tier-colored, red zone under 0.05. Hover highlights matching rows; click sets minWeight.
 */
export default function WeightHistogram({
  rows,
  minWeight,
  onHoverBucket,
  onPick,
}: {
  rows: Memory[];
  minWeight: number;
  onHoverBucket: (b: WeightBucket | null) => void;
  onPick: (min: number) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const buckets = useMemo<WeightBucket[]>(() => {
    const counts = new Array<number>(BUCKETS).fill(0);
    for (const m of rows) {
      const i = Math.min(BUCKETS - 1, Math.floor(m.weight * BUCKETS));
      counts[i]++;
    }
    return counts.map((count, i) => ({
      index: i,
      min: i / BUCKETS,
      max: (i + 1) / BUCKETS,
      count,
    }));
  }, [rows]);

  const maxCount = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <div className="relative border-t border-panel-border px-4 pb-1 pt-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="micro-label">Weight Distribution</span>
        <span className="font-mono text-[10px] text-danger">
          ▍AUTO-ARCHIVE ZONE &lt; {ARCHIVE_THRESHOLD.toFixed(2)}
        </span>
      </div>
      <div
        className="relative flex h-12 items-end gap-[2px]"
        onMouseLeave={() => {
          setHovered(null);
          onHoverBucket(null);
        }}
      >
        {/* red zone shading under 0.05 (first bucket) */}
        <span
          className="pointer-events-none absolute bottom-0 left-0 top-0 border-r border-dashed border-[rgba(255,51,85,0.5)] bg-[rgba(255,51,85,0.07)]"
          style={{ width: `${(1 / BUCKETS) * 100}%` }}
        />
        {buckets.map((b, i) => {
          const mid = (b.min + b.max) / 2;
          const color = weightColor(mid === ARCHIVE_THRESHOLD ? ARCHIVE_THRESHOLD : mid);
          const h = b.count === 0 ? 2 : Math.max(6, (b.count / maxCount) * 44);
          const isHover = hovered === i;
          const isFiltered = minWeight > 0 && b.min >= minWeight - 1e-9;
          return (
            <motion.button
              key={i}
              type="button"
              initial={{ height: 0 }}
              animate={{ height: h, y: isHover ? -2 : 0 }}
              transition={{
                height: { duration: 0.4, delay: i * 0.02, ease: [0.22, 1, 0.36, 1] },
                y: { duration: 0.15 },
              }}
              onMouseEnter={() => {
                setHovered(i);
                onHoverBucket(b);
              }}
              onClick={() => onPick(b.min)}
              title={`weight ${b.min.toFixed(2)}–${b.max.toFixed(2)} · ${b.count} engrams · click to set min weight`}
              className={cn(
                'relative flex-1 rounded-t-[2px] transition-opacity duration-200',
                hovered !== null && !isHover && 'opacity-35',
              )}
              style={{
                backgroundColor: color,
                opacity: isFiltered ? 1 : undefined,
                boxShadow: isHover || isFiltered ? `0 0 10px ${color}` : `0 0 4px ${color}44`,
              }}
            >
              {isHover && (
                <span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-panel-border bg-[rgba(2,6,14,0.9)] px-1.5 py-0.5 font-mono text-[10px] text-hi">
                  {b.min.toFixed(2)}–{b.max.toFixed(2)} · {b.count}
                </span>
              )}
            </motion.button>
          );
        })}
      </div>
      <div className="flex justify-between font-mono text-[9px] text-dim">
        <span>0.0</span>
        <span>0.25</span>
        <span>0.5</span>
        <span>0.75</span>
        <span>1.0</span>
      </div>
    </div>
  );
}
