import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import HoloPanel from '@/components/HoloPanel';
import { CountUp, hexA, tsNow } from './anim';

/**
 * BrainLoopPipeline — brain.md §2.
 * Per-turn intent classification as a horizontal signal pipeline:
 * TURN SIGNAL → classifier core → five intent lanes. A packet travels the
 * pipe every ~2.5s; high-signal lanes terminate in AUTO-STORE ENGRAM.
 */

type Lane = 'correction' | 'repetition' | 'preference' | 'tool_outcome' | 'generic';

const LANES: { id: Lane; color: string; autoStore?: boolean; base: number; pick: number }[] = [
  { id: 'correction', color: '#ff9f1c', autoStore: true, base: 23, pick: 0.14 },
  { id: 'repetition', color: '#8a97ab', base: 41, pick: 0.2 },
  { id: 'preference', color: '#4da6ff', autoStore: true, base: 12, pick: 0.1 },
  { id: 'tool_outcome', color: '#00d4ff', base: 88, pick: 0.28 },
  { id: 'generic', color: '#4b5f7c', base: 204, pick: 0.28 },
];

interface Packet {
  id: number;
  lane: Lane;
  phase: 'in' | 'route';
  trackW: number;
}

interface LogRow {
  id: number;
  text: string;
  color: string;
}

function pickLane(): Lane {
  const r = Math.random();
  let acc = 0;
  for (const l of LANES) {
    acc += l.pick;
    if (r <= acc) return l.id;
  }
  return 'generic';
}

export default function BrainLoopPipeline() {
  const [packet, setPacket] = useState<Packet | null>(null);
  const [burst, setBurst] = useState(0);
  const [counts, setCounts] = useState<Record<Lane, number>>(() =>
    Object.fromEntries(LANES.map((l) => [l.id, l.base])) as Record<Lane, number>,
  );
  const [flash, setFlash] = useState<{ lane: Lane; key: number } | null>(null);
  const [log, setLog] = useState<LogRow[]>([]);
  const seq = useRef(0);
  const inletRef = useRef<HTMLDivElement>(null);
  const trackRefs = useRef<Partial<Record<Lane, HTMLDivElement | null>>>({});

  // mock packet stream — one packet every ~2.5s
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const fire = () => {
      if (!alive) return;
      const lane = pickLane();
      const id = ++seq.current;
      setPacket({ id, lane, phase: 'in', trackW: trackRefs.current[lane]?.clientWidth ?? 300 });
      timer = window.setTimeout(fire, 2500);
    };
    timer = window.setTimeout(fire, 900);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  const land = (lane: Lane) => {
    setCounts((c) => ({ ...c, [lane]: c[lane] + 1 }));
    setFlash({ lane, key: seq.current });
    const meta = LANES.find((l) => l.id === lane)!;
    if (meta.autoStore) {
      setLog((rows) =>
        [
          {
            id: seq.current,
            text: `${tsNow()} ▸ ${lane} → AUTO-STORE ENGRAM · w +0.0${1 + (seq.current % 3)}`,
            color: meta.color,
          },
          ...rows,
        ].slice(0, 6),
      );
    }
    setPacket(null);
  };

  return (
    <HoloPanel
      title="BRAIN-LOOP · INTENT PIPELINE"
      headerRight={<span className="micro-label">metric: correction_stored</span>}
      className="h-full"
    >
      <div className="flex flex-col gap-4 p-4 lg:flex-row">
        {/* Left: turn signal + classifier core */}
        <div className="flex shrink-0 flex-row items-center gap-3 lg:w-[150px] lg:flex-col lg:items-stretch lg:gap-2">
          <div className="holo-corners relative rounded-md border border-panel-border bg-[rgba(2,6,14,0.5)] px-3 py-2 text-center">
            <div className="micro-label">Turn Signal</div>
            <div className="mt-0.5 font-mono text-[10px] text-mid">user + tool stream</div>
          </div>
          {/* inlet track */}
          <div ref={inletRef} className="relative h-[3px] min-w-10 flex-1 rounded bg-[rgba(0,212,255,0.12)] lg:h-[3px]">
            {packet?.phase === 'in' && (
              <motion.span
                key={`in-${packet.id}`}
                className="absolute top-1/2 h-[7px] w-[7px] -translate-y-1/2 rounded-full bg-arc"
                style={{ boxShadow: '0 0 10px var(--arc), 0 0 20px rgba(0,212,255,.5)' }}
                initial={{ x: -4, opacity: 0 }}
                animate={{ x: (inletRef.current?.clientWidth ?? 60) - 3, opacity: 1 }}
                transition={{ duration: 0.35, ease: 'easeIn' }}
                onAnimationComplete={() => {
                  setBurst((b) => b + 1);
                  setPacket((p) => (p ? { ...p, phase: 'route' } : p));
                }}
              />
            )}
          </div>
          {/* classifier core */}
          <div className="relative mx-auto h-[72px] w-[72px]">
            <motion.div
              key={burst}
              className="h-full w-full"
              style={{ filter: 'drop-shadow(0 0 10px rgba(0,212,255,0.45))' }}
              animate={{ scale: burst === 0 ? 1 : [1, 1.15, 1] }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <img
                src="/boot-reactor.svg"
                alt="Intent classifier core"
                className="animate-spin-slow h-full w-full"
              />
            </motion.div>
            <span className="micro-label absolute -bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap">
              classifier core
            </span>
          </div>
        </div>

        {/* Right: intent lanes */}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
          {LANES.map((lane) => (
            <div key={lane.id} className="relative flex items-center gap-3">
              <span
                className="w-[104px] shrink-0 rounded border px-2 py-1 text-center font-mono text-[10px] uppercase"
                style={{
                  color: lane.color,
                  borderColor: hexA(lane.color, 0.4),
                  backgroundColor: hexA(lane.color, 0.08),
                }}
              >
                {lane.id.replace('_', ' ')}
              </span>
              {/* lane track */}
              <div
                ref={(el) => {
                  trackRefs.current[lane.id] = el;
                }}
                className="relative h-[3px] min-w-0 flex-1 rounded"
                style={{ backgroundColor: hexA(lane.color, 0.14) }}
              >
                {/* lane flash on land */}
                {flash?.lane === lane.id && (
                  <motion.span
                    key={flash.key}
                    className="absolute inset-[-4px] rounded"
                    style={{ backgroundColor: hexA(lane.color, 0.12) }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0, 1, 0] }}
                    transition={{ duration: 0.4 }}
                  />
                )}
                {packet?.phase === 'route' && packet.lane === lane.id && (
                  <motion.span
                    key={`route-${packet.id}`}
                    className="absolute top-1/2 h-[7px] w-[7px] -translate-y-1/2 rounded-full"
                    style={{
                      backgroundColor: lane.color,
                      boxShadow: `0 0 10px ${lane.color}, 0 0 22px ${hexA(lane.color, 0.5)}`,
                    }}
                    initial={{ x: -4 }}
                    animate={{ x: packet.trackW - 3 }}
                    transition={{ duration: 0.9, ease: 'easeInOut' }}
                    onAnimationComplete={() => land(lane.id)}
                  />
                )}
              </div>
              {/* counter */}
              <motion.span
                key={counts[lane.id]}
                className="w-9 shrink-0 text-right font-mono text-[13px] font-bold"
                style={{ color: lane.color }}
                initial={{ scale: 1.35, textShadow: `0 0 14px ${lane.color}` }}
                animate={{ scale: 1, textShadow: '0 0 0px rgba(0,0,0,0)' }}
                transition={{ duration: 0.35 }}
              >
                <CountUp value={counts[lane.id]} duration={400} />
              </motion.span>
              {/* terminal node */}
              {lane.autoStore ? (
                <motion.span
                  key={`engram-${counts[lane.id]}`}
                  className="hidden shrink-0 items-center gap-1.5 rounded border border-[rgba(34,255,136,0.4)] bg-[rgba(34,255,136,0.08)] px-2 py-1 font-mono text-[10px] text-ok md:flex"
                  animate={{
                    boxShadow:
                      counts[lane.id] === lane.base
                        ? '0 0 0px rgba(34,255,136,0)'
                        : ['0 0 0px rgba(34,255,136,0)', '0 0 16px rgba(34,255,136,0.7)', '0 0 0px rgba(34,255,136,0)'],
                  }}
                  transition={{ duration: 0.5 }}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-ok shadow-[0_0_6px_var(--ok)]" />
                  → AUTO-STORE ENGRAM
                </motion.span>
              ) : (
                <span className="hidden w-[150px] shrink-0 font-mono text-[10px] text-dim md:block">
                  → context only
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* engram log */}
      <div className="holo-divider mx-4" />
      <div className="flex min-h-[46px] flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2.5">
        <span className="micro-label shrink-0">engram log</span>
        <AnimatePresence initial={false}>
          {log.slice(0, 3).map((row, i) => (
            <motion.span
              key={row.id}
              initial={{ y: -8, opacity: 0 }}
              animate={{ y: 0, opacity: 1 - i * 0.3 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="font-mono text-[11px]"
              style={{ color: row.color }}
            >
              {row.text}
            </motion.span>
          ))}
        </AnimatePresence>
        {log.length === 0 && (
          <span className="font-mono text-[11px] text-dim">awaiting high-signal intents…</span>
        )}
      </div>
    </HoloPanel>
  );
}
