import { useEffect, useState } from 'react';
import { weightColor, weightLabel, ARCHIVE_THRESHOLD } from '@/lib/colors';

/**
 * WeightGauge — design.md §7.5.
 * Arc-reactor radial gauge: 240° arc, ticks at 0.25/0.5, red zone under 0.05,
 * needle + mono readout (3 decimals), color follows weight tier.
 */
const START = -210; // degrees (240° sweep from -210 to +30)
const SWEEP = 240;
const angleFor = (w: number) => START + Math.min(1, Math.max(0, w)) * SWEEP;

export default function WeightGauge({ weight, size = 132 }: { weight: number; size?: number }) {
  const [display, setDisplay] = useState(0);

  // Needle sweep from 0 on mount (700ms, expo-out) + subtle idle flicker ±0.5%
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 700);
      const eased = 1 - Math.pow(2, -10 * p);
      setDisplay(weight * (p >= 1 ? 1 : eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else {
        // idle flicker
        const flicker = () => {
          setDisplay(weight * (1 + (Math.random() - 0.5) * 0.01));
          raf = requestAnimationFrame(() => setTimeout(flicker, 900));
        };
        flicker();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [weight]);

  const color = weightColor(weight);
  const r = 54;
  const cx = 70;
  const cy = 70;
  const polar = (deg: number, radius: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)] as const;
  };
  const arcPath = (from: number, to: number, radius: number) => {
    const [x1, y1] = polar(from, radius);
    const [x2, y2] = polar(to, radius);
    const large = to - from > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`;
  };

  const needleAngle = angleFor(display);
  const [nx, ny] = polar(needleAngle, r - 12);

  return (
    <div className="flex flex-col items-center" style={{ width: size }}>
      <svg viewBox="0 0 140 140" width={size} height={size} role="img" aria-label={`Weight ${weight.toFixed(3)}`}>
        {/* red archive zone under 0.05 */}
        <path
          d={arcPath(START, angleFor(ARCHIVE_THRESHOLD), r)}
          stroke="#ff3355"
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
          opacity="0.85"
        >
          <animate attributeName="opacity" values="0.85;0.35;0.85" dur="1.6s" repeatCount="indefinite" />
        </path>
        {/* base arc */}
        <path
          d={arcPath(angleFor(ARCHIVE_THRESHOLD), START + SWEEP, r)}
          stroke="rgba(0,212,255,0.15)"
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
        />
        {/* value arc */}
        <path
          d={arcPath(START, needleAngle, r)}
          stroke={color}
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 4px ${color})` }}
        />
        {/* tick marks at 0.25 / 0.5 */}
        {[0.25, 0.5].map((t) => {
          const [tx1, ty1] = polar(angleFor(t), r - 8);
          const [tx2, ty2] = polar(angleFor(t), r + 4);
          return (
            <line key={t} x1={tx1} y1={ty1} x2={tx2} y2={ty2} stroke="rgba(143,169,199,0.7)" strokeWidth="1.5" />
          );
        })}
        {/* needle */}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={color} strokeWidth="2.5" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="5" fill="var(--space)" stroke={color} strokeWidth="2" />
        <circle cx={cx} cy={cy} r="1.8" fill={color} />
      </svg>
      <div className="-mt-5 text-center">
        <div className="font-mono text-lg font-bold leading-none text-glow" style={{ color }}>
          {display.toFixed(3)}
        </div>
        <div className="micro-label mt-1" style={{ color }}>
          {weightLabel(weight)}
        </div>
      </div>
    </div>
  );
}
