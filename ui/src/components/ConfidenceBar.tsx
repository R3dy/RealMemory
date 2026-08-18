import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * ConfidenceBar — design.md §7.6.
 * 20-segment horizontal bar, filled = confidence × 20, cyan fill, glow on last lit segment.
 */
export default function ConfidenceBar({
  confidence,
  className,
}: {
  confidence: number;
  className?: string;
}) {
  const [lit, setLit] = useState(0);
  const target = Math.round(Math.min(1, Math.max(0, confidence)) * 20);

  useEffect(() => {
    setLit(0);
    let i = 0;
    const iv = window.setInterval(() => {
      i++;
      setLit(Math.min(i, target));
      if (i >= target) window.clearInterval(iv);
    }, 28);
    return () => window.clearInterval(iv);
  }, [target]);

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between">
        <span className="micro-label">Confidence</span>
        <span className="font-mono text-sm font-bold text-arc text-glow">{confidence.toFixed(2)}</span>
      </div>
      <div className="flex gap-[2px]" role="img" aria-label={`Confidence ${confidence.toFixed(2)}`}>
        {Array.from({ length: 20 }, (_, i) => {
          const on = i < lit;
          const last = on && i === lit - 1;
          return (
            <span
              key={i}
              className="h-3 flex-1 rounded-[1px] transition-colors duration-100"
              style={{
                backgroundColor: on ? 'var(--arc)' : 'rgba(0,212,255,0.12)',
                boxShadow: last ? '0 0 8px rgba(0,212,255,0.8)' : undefined,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
