import { cn } from '@/lib/utils';

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * SynapseTag — design.md §7.7.
 * Pill: 1px semantic-colored border, 10% fill, mono 11px uppercase, colored left dot.
 */
export default function SynapseTag({
  label,
  color = '#00d4ff',
  dot = true,
  active = false,
  onClick,
  className,
}: {
  label: string;
  color?: string;
  dot?: boolean;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] font-mono text-[11px] uppercase leading-none tracking-wide transition-all duration-200',
        onClick && 'cursor-pointer hover:-translate-y-px',
        className,
      )}
      style={{
        borderColor: hexToRgba(color, active ? 0.8 : 0.45),
        backgroundColor: hexToRgba(color, active ? 0.2 : 0.1),
        color,
        boxShadow: active ? `0 0 10px ${hexToRgba(color, 0.35)}` : undefined,
      }}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />}
      {label}
    </Tag>
  );
}
