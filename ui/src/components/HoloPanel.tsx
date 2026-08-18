import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * HoloPanel — design.md §4 anatomy / §7.4.
 * Variants: `solid` (drawers), `ghost` (floating over canvas), default glass.
 */
export default function HoloPanel({
  title,
  led = true,
  collapsible = false,
  defaultCollapsed = false,
  variant = 'default',
  corners = true,
  className,
  headerRight,
  children,
}: {
  title?: string;
  led?: boolean;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  variant?: 'default' | 'solid' | 'ghost';
  corners?: boolean;
  className?: string;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <section
      className={cn(
        'holo-panel',
        variant === 'solid' && 'holo-panel-solid',
        variant === 'ghost' && 'holo-panel-ghost',
        corners && 'holo-corners',
        className,
      )}
    >
      {title && (
        <header className="relative z-10 flex items-center gap-2 border-b border-panel-border px-4 py-2.5">
          {led && <span className="animate-led h-1.5 w-1.5 rounded-full bg-arc shadow-[0_0_6px_var(--arc)]" />}
          <h2 className="font-display text-[13px] font-bold tracking-[0.14em] text-hi">{title}</h2>
          <div className="ml-auto flex items-center gap-2">
            {headerRight}
            {collapsible && (
              <button
                type="button"
                aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
                onClick={() => setCollapsed((c) => !c)}
                className="text-dim transition-colors hover:text-arc"
              >
                <ChevronDown
                  size={14}
                  className={cn('transition-transform duration-300', collapsed && '-rotate-90')}
                />
              </button>
            )}
          </div>
        </header>
      )}
      <div className={cn('relative z-10', title && collapsed && 'hidden')}>{children}</div>
    </section>
  );
}
