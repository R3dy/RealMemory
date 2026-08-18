import { useUiStore } from '@/lib/ui-store';

/** Minimal HUD footer strip — status line + credits. */
export default function Footer() {
  const { scope } = useUiStore();
  return (
    <footer className="z-40 flex h-7 w-full shrink-0 items-center gap-4 border-t border-panel-border bg-[rgba(5,11,24,0.72)] px-4 font-mono text-[10px] text-dim backdrop-blur-[14px]">
      <span className="flex items-center gap-1.5">
        <span className="animate-led h-1 w-1 rounded-full bg-ok" />
        CORTEX RENDER ONLINE
      </span>
      <span className="hidden sm:inline">SCOPE: {scope.toUpperCase()}</span>
      <span className="hidden md:inline">DECAY HALF-LIFE 30D · AUTO-ARCHIVE &lt; 0.05</span>
      <span className="ml-auto">
        REALMEMORY // NEURAL INTERFACE — synthetic persistent memory for AI agents
      </span>
    </footer>
  );
}
