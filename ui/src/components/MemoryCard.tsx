import { memo } from 'react';
import type { Memory } from '@/lib/data';
import { TYPE_COLORS, weightColor, weightLabel } from '@/lib/colors';
import SynapseTag from './SynapseTag';
import { cn } from '@/lib/utils';

function timeAgo(isoDate: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * MemoryCard — design.md §7.8.
 * Type-colored 3px left bar, 2-line content clamp, footer of tags + weight pill + mono timestamp.
 */
export default memo(function MemoryCard({
  memory,
  onClick,
  compact = false,
  active = false,
  className,
}: {
  memory: Memory;
  onClick?: (memory: Memory) => void;
  compact?: boolean;
  active?: boolean;
  className?: string;
}) {
  const typeColor = TYPE_COLORS[memory.type];
  return (
    <article
      onClick={() => onClick?.(memory)}
      className={cn(
        'group relative border border-panel-border bg-[rgba(8,20,38,0.45)] backdrop-blur-sm transition-all duration-200',
        onClick && 'cursor-pointer hover:-translate-y-px hover:border-panel-hot hover:shadow-glow-arc',
        active && 'border-panel-hot shadow-glow-arc',
        compact ? 'rounded-md p-2.5 pl-3' : 'rounded-lg p-3.5 pl-4',
        className,
      )}
    >
      {/* type-colored left bar */}
      <span
        className="absolute left-0 top-0 h-full w-[3px] rounded-l-lg"
        style={{ backgroundColor: typeColor, boxShadow: `0 0 8px ${typeColor}66` }}
      />
      {!compact && (
        <div className="mb-1.5 flex items-center gap-2">
          <SynapseTag label={memory.type} color={typeColor} />
          <SynapseTag label={memory.scope} color={memory.scope === 'project' ? '#00d4ff' : '#b26bff'} />
        </div>
      )}
      <p
        className={cn(
          'font-body leading-snug text-hi',
          compact ? 'line-clamp-1 text-[13px]' : 'line-clamp-2 text-[15px]',
        )}
      >
        {memory.content}
      </p>
      <div className={cn('flex flex-wrap items-center gap-1.5', compact ? 'mt-1.5' : 'mt-2.5')}>
        {memory.domain && <SynapseTag label={memory.domain} color="#7de9ff" dot={false} />}
        {!compact && memory.category && <SynapseTag label={memory.category} color="#8fa9c7" dot={false} />}
        <span
          className="ml-auto inline-flex items-center gap-1 rounded-full border px-2 py-[2px] font-mono text-[11px] font-bold"
          style={{
            color: weightColor(memory.weight),
            borderColor: `${weightColor(memory.weight)}55`,
            backgroundColor: `${weightColor(memory.weight)}14`,
          }}
        >
          W {memory.weight.toFixed(2)} · {weightLabel(memory.weight)}
        </span>
        <span className="font-mono text-[11px] text-dim">{timeAgo(memory.updatedAt)}</span>
      </div>
    </article>
  );
});
