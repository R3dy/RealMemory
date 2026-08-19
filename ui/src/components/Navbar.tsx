import { useEffect, useRef, useState } from 'react';
import { Link, NavLink } from 'react-router';
import { FileJson, Loader2, RotateCcw, Search, Settings, Upload } from 'lucide-react';
import { uiStore, useUiStore, requestCommandPalette } from '@/lib/ui-store';
import { connectLive, getDataSourceInfo, importDataset, resetToDemo } from '@/lib/data';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Neural Graph' },
  { to: '/memories', label: 'Memory Index' },
  { to: '/domains', label: 'Domain Atlas' },
  { to: '/brain', label: 'Synthetic Brain' },
  { to: '/vitals', label: 'Brain Health' },
];

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const iv = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(iv);
  }, []);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="hidden font-mono text-[12px] text-mid md:inline">
      {pad(now.getUTCHours())}
      <span className="animate-led">:</span>
      {pad(now.getUTCMinutes())}
      <span className="animate-led">:</span>
      {pad(now.getUTCSeconds())} UTC
    </span>
  );
}

function ScopeToggle() {
  const { scope } = useUiStore();
  const options = ['project', 'global', 'all'] as const;
  return (
    <div className="relative hidden items-center rounded-full border border-panel-border bg-[rgba(2,6,14,0.5)] p-[3px] lg:flex">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => uiStore.set({ scope: o })}
          className={cn(
            'relative z-10 rounded-full px-3 py-1 font-display text-[10px] font-bold tracking-[0.14em] transition-colors duration-200',
            scope === o ? 'text-void' : 'text-dim hover:text-arc',
          )}
        >
          {scope === o && (
            <span className="absolute inset-0 -z-10 rounded-full bg-arc shadow-[0_0_10px_rgba(0,212,255,0.5)] transition-all" />
          )}
          {o.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const ui = useUiStore();

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Display settings"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'rounded-md border border-transparent p-1.5 text-dim transition-colors hover:border-panel-border hover:text-arc',
          open && 'border-panel-border text-arc',
        )}
      >
        <Settings size={16} />
      </button>
      {open && (
        <div className="holo-panel holo-panel-solid holo-corners absolute right-0 top-9 z-50 w-64 animate-holo-reveal p-4">
          <div className="micro-label mb-3">Cortex Display</div>
          <label className="flex cursor-pointer items-center justify-between py-1.5 text-[13px] text-mid">
            Auto-rotation
            <input
              type="checkbox"
              checked={ui.autoRotate}
              onChange={(e) => uiStore.set({ autoRotate: e.target.checked })}
              className="h-3.5 w-3.5 accent-[#00d4ff]"
            />
          </label>
          <label className="block py-1.5 text-[13px] text-mid">
            <span className="mb-1 flex justify-between">
              Pulse density
              <span className="font-mono text-[11px] text-arc">{ui.pulseDensity.toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={ui.pulseDensity}
              onChange={(e) => uiStore.set({ pulseDensity: Number(e.target.value) })}
              className="w-full accent-[#ffb627]"
            />
          </label>
          <label className="block py-1.5 text-[13px] text-mid">
            <span className="mb-1 flex justify-between">
              Glow
              <span className="font-mono text-[11px] text-arc">{ui.glowIntensity.toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={ui.glowIntensity}
              onChange={(e) => uiStore.set({ glowIntensity: Number(e.target.value) })}
              className="w-full accent-[#00d4ff]"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between py-1.5 text-[13px] text-mid">
            Reduced motion
            <input
              type="checkbox"
              checked={ui.reducedMotion}
              onChange={(e) => uiStore.set({ reducedMotion: e.target.checked })}
              className="h-3.5 w-3.5 accent-[#00d4ff]"
            />
          </label>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection chip — live API link / JSON import / demo simulation
// ---------------------------------------------------------------------------

const CHIP_STYLES = {
  live: {
    chip: 'border-[rgba(34,255,136,0.45)] bg-[rgba(34,255,136,0.08)] text-ok',
    dot: 'bg-ok shadow-[0_0_6px_#22ff88]',
  },
  import: {
    chip: 'border-[rgba(0,212,255,0.45)] bg-[rgba(0,212,255,0.08)] text-arc',
    dot: 'bg-arc shadow-[0_0_6px_var(--arc)]',
  },
  demo: {
    chip: 'border-[rgba(255,182,39,0.4)] bg-[rgba(255,182,39,0.08)] text-reactor',
    dot: 'bg-reactor shadow-[0_0_6px_var(--reactor)]',
  },
} as const;

function ConnectionChip() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { dataVersion } = useUiStore();
  const info = getDataSourceInfo(); // re-read on every dataVersion bump
  const [url, setUrl] = useState(() => getDataSourceInfo().baseUrl ?? 'http://127.0.0.1:9333');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // keep the input in sync when a live link is established elsewhere
  useEffect(() => {
    if (info.mode === 'live' && info.baseUrl) setUrl(info.baseUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion]);

  const style = CHIP_STYLES[info.mode];
  const chipLabel =
    info.mode === 'live'
      ? `LIVE LINKED ${info.baseUrl?.replace(/^https?:\/\//, '') ?? ''}`
      : info.mode === 'import'
        ? 'IMPORTED DATASET'
        : 'SIMULATION MODE';

  const handleConnect = async () => {
    setBusy(true);
    setMsg(null);
    const res = await connectLive(url);
    setBusy(false);
    setMsg(
      res.ok
        ? { ok: true, text: `Linked — ${getDataSourceInfo().nodeCount} engrams streaming from ${url}` }
        : { ok: false, text: res.error ?? 'Connection failed.' },
    );
  };

  const handleFile = async (file: File | undefined | null) => {
    if (!file) return;
    setMsg(null);
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      setMsg({ ok: false, text: `${file.name} is not valid JSON.` });
      return;
    }
    const res = importDataset(json);
    setMsg(
      res.ok
        ? {
            ok: true,
            text: `Imported ${res.nodeCount} engrams · ${res.edgeCount} synapses${res.persisted ? '' : ' (session only — storage full)'}`,
          }
        : { ok: false, text: res.error },
    );
  };

  return (
    <div ref={ref} className="relative hidden md:block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-shadow hover:shadow-glow-arc',
          style.chip,
        )}
      >
        <span className={cn('animate-led h-1.5 w-1.5 rounded-full', style.dot)} />
        {chipLabel}
      </button>

      {open && (
        <div className="holo-panel holo-panel-solid holo-corners absolute left-0 top-9 z-50 w-[340px] animate-holo-reveal p-4">
          {/* current mode */}
          <div className="mb-3 flex items-center gap-2">
            <span className={cn('animate-led h-1.5 w-1.5 rounded-full', style.dot)} />
            <span className="font-display text-[11px] font-bold tracking-[0.16em] text-hi">{chipLabel}</span>
            <span className="ml-auto font-mono text-[10px] text-dim">
              {info.nodeCount}N · {info.edgeCount}E
            </span>
          </div>

          {/* live connect */}
          <div className="micro-label mb-1.5">Live API Link</div>
          <div className="flex gap-1.5">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleConnect();
              }}
              placeholder="http://127.0.0.1:9333"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-panel-border bg-[rgba(2,6,14,0.5)] px-2 py-1.5 font-mono text-[11px] text-hi outline-none placeholder:text-dim focus:border-panel-hot"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleConnect()}
              className="flex shrink-0 items-center gap-1 rounded-md border border-panel-hot px-2.5 font-display text-[10px] font-bold tracking-[0.14em] text-arc transition-shadow hover:shadow-glow-arc disabled:opacity-50"
            >
              {busy && <Loader2 size={11} className="animate-spin" />}
              CONNECT
            </button>
          </div>

          {/* file import */}
          <div className="micro-label mb-1.5 mt-4">Import Dataset</div>
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') fileRef.current?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void handleFile(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center gap-1.5 rounded-md border border-dashed px-3 py-4 text-center transition-colors',
              drag ? 'border-panel-hot bg-[rgba(0,212,255,0.08)]' : 'border-panel-border hover:border-panel-hot',
            )}
          >
            <Upload size={16} className="text-arc" />
            <span className="font-mono text-[11px] text-mid">
              Drop <span className="text-hi">my-memories.json</span> here or click to browse
            </span>
            <span className="font-mono text-[9px] leading-relaxed text-dim">
              Run <code className="text-arc">npx realmemory-mcp --ui</code> locally, then
              <br />
              <code className="text-arc">curl http://127.0.0.1:9333/api/graph?limit=2000 &gt; my-memories.json</code>
              <br />
              and drop the file here
            </span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              void handleFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />

          {/* status + reset */}
          {msg && (
            <div
              className={cn(
                'mt-3 flex items-start gap-1.5 rounded-md border px-2 py-1.5 font-mono text-[10px] leading-snug',
                msg.ok
                  ? 'border-[rgba(34,255,136,0.35)] bg-[rgba(34,255,136,0.06)] text-ok'
                  : 'border-[rgba(255,51,85,0.35)] bg-[rgba(255,51,85,0.06)] text-danger',
              )}
            >
              <FileJson size={11} className="mt-[1px] shrink-0" />
              {msg.text}
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              resetToDemo();
              setMsg({ ok: true, text: 'Demo simulation restored.' });
            }}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-panel-border py-1.5 font-display text-[10px] font-bold tracking-[0.16em] text-dim transition-colors hover:border-panel-hot hover:text-reactor"
          >
            <RotateCcw size={11} /> RESET TO DEMO DATA
          </button>
        </div>
      )}
    </div>
  );
}

/** Top HUD Bar — design.md §7.1. Sticky, 60px, glass. */
export default function Navbar() {
  return (
    <header className="sticky top-0 z-50 flex h-[60px] w-full items-center gap-4 border-b border-panel-border bg-[rgba(8,20,38,0.55)] px-4 backdrop-blur-[14px]">
      {/* Logo + wordmark */}
      <Link to="/" className="flex shrink-0 items-center gap-2.5">
        <img src="/logo.svg" alt="RealMemory" className="animate-spin-slow h-8 w-8" />
        <span className="hidden flex-col leading-tight sm:flex">
          <span className="font-display text-[13px] font-black text-hi">REALMEMORY</span>
          <span className="micro-label">Neural Interface v0.13.0</span>
        </span>
      </Link>

      {/* Connection chip — live link / import / simulation panel */}
      <ConnectionChip />

      {/* Route links */}
      <nav className="hidden items-center gap-1 xl:flex">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              cn(
                'rounded-md px-2.5 py-1 font-display text-[10px] font-bold tracking-[0.14em] transition-colors',
                isActive ? 'text-arc shadow-[inset_0_-2px_0_var(--arc)]' : 'text-dim hover:text-hi',
              )
            }
          >
            {n.label}
          </NavLink>
        ))}
      </nav>

      {/* Center search */}
      <div className="mx-auto w-full max-w-[360px]">
        <button
          type="button"
          onClick={requestCommandPalette}
          className="flex w-full items-center gap-2 rounded-lg border border-panel-border bg-[rgba(2,6,14,0.5)] px-3 py-1.5 text-left text-[13px] text-dim transition-all duration-200 hover:border-panel-hot hover:shadow-glow-arc"
        >
          <Search size={14} className="text-arc" />
          <span className="flex-1">Search engrams…</span>
          <kbd className="rounded border border-panel-border px-1.5 font-mono text-[10px] text-dim">⌘K</kbd>
        </button>
      </div>

      {/* Right cluster */}
      <div className="ml-auto flex shrink-0 items-center gap-4">
        <LiveClock />
        <ScopeToggle />
        <SettingsMenu />
      </div>
    </header>
  );
}
