import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import HoloPanel from '@/components/HoloPanel';
import { CountUp } from './anim';

/**
 * ScrubPanel — brain.md §7.
 * Terminal-style redaction feed: a new scrub event types itself every ~9s,
 * the secret span is wiped to [REDACTED] (amber), counter ticks up.
 */

interface ScrubEvent {
  type: string;
  input: string;
  secret: string;
}

const EVENTS: ScrubEvent[] = [
  { type: 'api_key', input: 'store "API key sk-4f9ab21cd3"', secret: 'sk-4f9ab21cd3' },
  { type: 'token', input: 'store "GITHUB_TOKEN ghp_X9k2mQ7"', secret: 'ghp_X9k2mQ7' },
  { type: 'password', input: 'store "db password Tr0pic!99"', secret: 'Tr0pic!99' },
  { type: 'conn_string', input: 'store "postgres://agent:pw@db:5432/prod"', secret: 'agent:pw' },
  { type: 'api_key', input: 'store "OPENAI_API_KEY=sk-proj-8f2k"', secret: 'sk-proj-8f2k' },
  { type: 'token', input: 'store "bearer eyJhbGciOiJIUzI1"', secret: 'eyJhbGciOiJIUzI1' },
];

const TYPE_CHIPS = [
  { label: 'api_key 11', color: '#ffb627' },
  { label: 'token 9', color: '#00d4ff' },
  { label: 'password 4', color: '#ff3355' },
  { label: 'conn_string 3', color: '#b26bff' },
];

interface Line {
  id: number;
  kind: 'in' | 'out';
  before: string;
  secret?: string;
  after?: string;
  text?: string;
}

export default function ScrubPanel() {
  const [lines, setLines] = useState<Line[]>([]);
  const [typing, setTyping] = useState<{ id: number; text: string } | null>(null);
  const [count, setCount] = useState(27);
  const [flash, setFlash] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    let charIv = 0;

    const emit = () => {
      if (!alive) return;
      const ev = EVENTS[seq.current % EVENTS.length];
      const id = ++seq.current;
      const idx = ev.input.indexOf(ev.secret);
      const before = ev.input.slice(0, idx);
      const after = ev.input.slice(idx + ev.secret.length);
      // typewriter — 24ms/char
      let n = 0;
      setTyping({ id, text: '' });
      charIv = window.setInterval(() => {
        n++;
        setTyping({ id, text: ev.input.slice(0, n) });
        if (n >= ev.input.length) {
          window.clearInterval(charIv);
          timer = window.setTimeout(() => {
            if (!alive) return;
            setTyping(null);
            setLines((rows) =>
              [
                ...rows,
                { id: id * 10 + 1, kind: 'in' as const, before: ev.input, text: ev.input },
                { id: id * 10 + 2, kind: 'out' as const, before, secret: ev.secret, after },
              ].slice(-8),
            );
            setCount((c) => c + 1);
            setFlash((f) => f + 1);
            timer = window.setTimeout(emit, 9000);
          }, 420);
        }
      }, 24);
    };

    timer = window.setTimeout(emit, 1400);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearInterval(charIv);
    };
  }, []);

  return (
    <HoloPanel
      title="SCRUB · SECRET REDACTION"
      className="h-full"
      headerRight={
        <motion.span
          key={flash}
          className="font-mono text-[11px] font-bold text-reactor"
          initial={{ textShadow: '0 0 14px rgba(255,182,39,0.9)', scale: 1.12 }}
          animate={{ textShadow: '0 0 0px rgba(255,182,39,0)', scale: 1 }}
          transition={{ duration: 0.3 }}
        >
          SECRETS SCRUBBED <CountUp value={count} duration={300} />
        </motion.span>
      }
    >
      <div className="p-4">
        {/* terminal */}
        <div className="flex min-h-[220px] flex-col justify-end gap-1 rounded-md border border-panel-border bg-[rgba(2,6,14,0.65)] p-3 font-mono text-[11.5px]">
          {lines.map((l, i) => (
            <motion.div
              key={l.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: i < lines.length - 6 ? 0.4 : 1, y: 0 }}
              transition={{ duration: 0.25 }}
              className="truncate"
            >
              {l.kind === 'in' ? (
                <span className="text-mid">
                  <span className="text-arc">›</span> {l.text}
                </span>
              ) : (
                <span className="text-mid">
                  <span className="text-ok">←</span> {l.before}
                  <motion.mark
                    className="rounded-sm px-1 font-bold text-void"
                    style={{ backgroundColor: 'var(--reactor)', transformOrigin: 'left center' }}
                    initial={{ scaleX: 0, opacity: 0 }}
                    animate={{ scaleX: 1, opacity: 1 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                  >
                    [REDACTED]
                  </motion.mark>
                  {l.after}
                </span>
              )}
            </motion.div>
          ))}
          {typing && (
            <div className="truncate text-mid">
              <span className="text-arc">›</span> {typing.text}
              <span className="animate-caret-blink text-arc">▌</span>
            </div>
          )}
          {lines.length === 0 && !typing && (
            <span className="text-dim">scrub filter armed — watching store payloads…</span>
          )}
        </div>

        {/* type chips */}
        <div className="mt-3 flex flex-wrap gap-2">
          {TYPE_CHIPS.map((c) => (
            <span
              key={c.label}
              className="rounded-full border px-2 py-[3px] font-mono text-[10px] uppercase"
              style={{ color: c.color, borderColor: `${c.color}55`, backgroundColor: `${c.color}14` }}
            >
              {c.label}
            </span>
          ))}
        </div>
        <div className="mt-2 font-mono text-[10px] text-dim">
          patterns: api_key · token · password · conn_string — redacted pre-storage, never persisted
        </div>
      </div>
    </HoloPanel>
  );
}
