import { NavLink } from 'react-router';
import { Activity, Brain, Cpu, Hexagon, Table2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const ITEMS = [
  { to: '/', label: 'Neural Graph', icon: Brain },
  { to: '/memories', label: 'Memory Index', icon: Table2 },
  { to: '/domains', label: 'Domain Atlas', icon: Hexagon },
  { to: '/brain', label: 'Synthetic Brain', icon: Cpu },
  { to: '/vitals', label: 'Brain Health', icon: Activity },
];

/**
 * NavRail — design.md §7.2.
 * 64px vertical icon rail; expands to 200px on hover, labels slide in.
 */
export default function NavRail() {
  return (
    <nav
      aria-label="Primary"
      className="group z-40 flex w-16 shrink-0 flex-col gap-1 overflow-hidden border-r border-panel-border bg-[rgba(5,11,24,0.72)] py-4 backdrop-blur-[14px] transition-[width] [transition-duration:250ms] ease-out hover:w-[200px]"
    >
      {ITEMS.map((item, i) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) =>
            cn(
              'relative mx-2 flex h-11 items-center gap-3 rounded-md px-[13px] transition-colors duration-200',
              isActive ? 'text-arc' : 'text-dim hover:bg-[rgba(0,212,255,0.06)] hover:text-hi',
            )
          }
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <span className="absolute left-[-9px] top-1/2 h-6 w-[2px] -translate-y-1/2 bg-arc shadow-[0_0_8px_var(--arc)]" />
              )}
              <item.icon
                size={20}
                className={cn('shrink-0', isActive && 'drop-shadow-[0_0_6px_rgba(0,212,255,0.7)]')}
              />
              <span
                className="-translate-x-2 whitespace-nowrap font-display text-[10px] font-bold tracking-[0.18em] opacity-0 transition-all [transition-duration:250ms] group-hover:translate-x-0 group-hover:opacity-100"
                style={{ transitionDelay: `${i * 40}ms` }}
              >
                <span className={cn(isActive ? 'text-hi' : undefined)}>{item.label}</span>
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
