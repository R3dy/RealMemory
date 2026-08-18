import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, Copy, X } from 'lucide-react';
import type { Memory } from '@/lib/data';
import { getMemory, getRelationships } from '@/lib/data';
import { TYPE_COLORS, EDGE_COLORS } from '@/lib/colors';
import SynapseTag from './SynapseTag';
import WeightGauge from './WeightGauge';
import ConfidenceBar from './ConfidenceBar';
import HoloPanel from './HoloPanel';
import { cn } from '@/lib/utils';

function rel(isoDate: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function day(isoDate: string): string {
  return isoDate.slice(0, 10);
}

/** Tiny syntax-tinted JSON renderer (mono 11px). */
function JsonView({ value }: { value: unknown }) {
  const json = JSON.stringify(value, null, 2) ?? 'null';
  const parts = json.split(
    /("(?:\\.|[^"\\])*"(?:\s*:)?|-?\d+\.?\d*(?:e[+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b)/g,
  );
  return (
    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
      {parts.map((p, i) => {
        let color = 'var(--text-mid)';
        if (p.startsWith('"')) color = p.trimEnd().endsWith(':') ? 'var(--arc-soft)' : 'var(--ok)';
        else if (/^-?\d/.test(p)) color = 'var(--reactor)';
        else if (/^(true|false|null)$/.test(p)) color = '#b26bff';
        return (
          <span key={i} style={{ color }}>
            {p}
          </span>
        );
      })}
    </pre>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="micro-label mb-2 mt-5 first:mt-0">{children}</div>;
}

function DrawerBody({ memory, onNavigate }: { memory: Memory; onNavigate: (id: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const relationships = useMemo(() => getRelationships(memory.id), [memory.id]);
  const typeColor = TYPE_COLORS[memory.type];

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(memory.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header: mono ULID (click = copy) + close is rendered by parent */}
      <button
        type="button"
        onClick={copyId}
        title="Copy ULID"
        className="group flex items-center gap-2 font-mono text-[12px] text-mid transition-colors hover:text-arc"
      >
        <span className="truncate">ENGRAM {memory.id}</span>
        {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} className="opacity-40 group-hover:opacity-100" />}
      </button>

      {/* Badges row */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <SynapseTag label={memory.type} color={typeColor} active />
        <SynapseTag label={memory.scope} color={memory.scope === 'project' ? '#00d4ff' : '#b26bff'} />
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase text-ok">
          <span className="animate-led h-1.5 w-1.5 rounded-full bg-ok shadow-[0_0_6px_var(--ok)]" />
          {memory.status}
        </span>
      </div>

      {/* Content */}
      <SectionLabel>Content</SectionLabel>
      <p className="font-body text-[16px] font-medium leading-relaxed text-hi">{memory.content}</p>

      {/* Domain / category / tags */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {memory.domain && <SynapseTag label={memory.domain} color="#7de9ff" />}
        {memory.category && <SynapseTag label={memory.category} color="#8fa9c7" />}
        {memory.tags.map((t) => (
          <SynapseTag key={t} label={t} color="#4da6ff" dot={false} />
        ))}
      </div>

      {/* Gauges */}
      <div className="mt-5 grid grid-cols-[auto_1fr] items-center gap-4 rounded-lg border border-panel-border bg-[rgba(2,6,14,0.4)] p-3">
        <WeightGauge weight={memory.weight} size={124} />
        <div className="flex flex-col gap-4">
          <ConfidenceBar confidence={memory.confidence} />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="micro-label">Accessed</div>
              <div className="font-mono text-lg font-bold text-hi text-glow">{memory.accessCount}×</div>
            </div>
            <div>
              <div className="micro-label">Reinforced</div>
              <div className="font-mono text-lg font-bold text-hi text-glow">{memory.reinforcementCount}×</div>
            </div>
          </div>
        </div>
      </div>

      {/* Source box */}
      {memory.source && (
        <>
          <SectionLabel>Source</SectionLabel>
          <div className="space-y-1 rounded-lg border border-panel-border bg-[rgba(2,6,14,0.4)] p-3 font-mono text-[11px]">
            {memory.source.project && (
              <div className="flex justify-between gap-2">
                <span className="text-dim">project</span>
                <span className="text-mid">{memory.source.project}</span>
              </div>
            )}
            {memory.source.session && (
              <div className="flex justify-between gap-2">
                <span className="text-dim">session</span>
                <span className="text-mid">{memory.source.session}</span>
              </div>
            )}
            {memory.source.ref && (
              <div className="flex justify-between gap-2">
                <span className="text-dim">ref</span>
                <span className="text-mid">{memory.source.ref}</span>
              </div>
            )}
            {memory.source.refType && (
              <div className="flex justify-between gap-2">
                <span className="text-dim">refType</span>
                <span className="text-mid">{memory.source.refType}</span>
              </div>
            )}
          </div>
        </>
      )}

      {/* Timeline */}
      <SectionLabel>Timeline</SectionLabel>
      <div className="relative flex items-center justify-between px-1 font-mono text-[11px]">
        <span className="absolute left-4 right-4 top-[3px] h-px bg-gradient-to-r from-transparent via-[var(--arc-dim)] to-transparent" />
        <div className="relative flex flex-col gap-1">
          <span className="h-[7px] w-[7px] rounded-full bg-arc shadow-[0_0_6px_var(--arc)]" />
          <span className="text-mid">created {day(memory.createdAt)}</span>
          <span className="text-dim">{rel(memory.createdAt)}</span>
        </div>
        <div className="relative flex flex-col items-end gap-1">
          <span className="h-[7px] w-[7px] rounded-full bg-reactor shadow-[0_0_6px_var(--reactor)]" />
          <span className="text-mid">updated {day(memory.updatedAt)}</span>
          <span className="text-dim">{rel(memory.updatedAt)}</span>
        </div>
      </div>

      {/* Structured metadata */}
      {memory.type === 'lesson_learned' && memory.metadata?.lesson && (
        <>
          <SectionLabel>Encoded Lesson</SectionLabel>
          <div className="space-y-2">
            {(
              [
                ['ASSUMED', memory.metadata.assumed, '#ff3355'],
                ['REALITY', memory.metadata.reality, '#ffd319'],
                ['LESSON', memory.metadata.lesson, '#22ff88'],
              ] as const
            ).map(([label, text, color]) => (
              <div
                key={label}
                className="rounded-r-md border border-panel-border bg-[rgba(2,6,14,0.4)] p-2.5"
                style={{ borderLeft: `3px solid ${color}` }}
              >
                <div className="micro-label" style={{ color }}>
                  {label}
                </div>
                <p className="mt-1 text-[13px] leading-snug text-mid">{String(text)}</p>
              </div>
            ))}
          </div>
          {Array.isArray(memory.metadata.reinforced) && memory.metadata.reinforced.length > 0 && (
            <>
              <SectionLabel>Reinforced History</SectionLabel>
              <div className="space-y-1.5 border-l border-panel-border pl-3">
                {(memory.metadata.reinforced as string[]).map((d, i) => (
                  <div key={i} className="relative flex items-center gap-2 font-mono text-[11px] text-mid">
                    <span className="absolute -left-[17px] h-[7px] w-[7px] rounded-full bg-ok shadow-[0_0_6px_var(--ok)]" />
                    {day(d)} <span className="text-dim">· {rel(d)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {memory.type === 'codebase_fact' && (memory.metadata?.location || memory.metadata?.evidence) && (
        <>
          <SectionLabel>Codebase Fact</SectionLabel>
          <div className="space-y-2">
            {memory.metadata.location && (
              <SynapseTag label={String(memory.metadata.location)} color="#ffd319" dot={false} />
            )}
            {memory.metadata.evidence && (
              <p className="font-mono text-[11px] leading-snug text-mid">{String(memory.metadata.evidence)}</p>
            )}
          </div>
        </>
      )}

      {memory.type === 'session_summary' && Array.isArray(memory.metadata?.outcomes) && (
        <>
          <SectionLabel>Outcomes</SectionLabel>
          <ul className="space-y-1">
            {(memory.metadata.outcomes as string[]).map((o, i) => (
              <li key={i} className="flex items-center gap-2 text-[13px] text-mid">
                <span className="h-1 w-1 rounded-full bg-arc" />
                {o}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Raw JSON */}
      <button
        type="button"
        onClick={() => setJsonOpen((o) => !o)}
        className="mt-5 flex items-center gap-2 text-left"
      >
        <span className="micro-label">Raw Metadata JSON</span>
        <ChevronDown size={12} className={cn('text-dim transition-transform', jsonOpen && 'rotate-180')} />
      </button>
      {jsonOpen && (
        <div className="mt-2 rounded-lg border border-panel-border bg-[rgba(2,6,14,0.5)] p-3">
          <JsonView value={memory.metadata} />
        </div>
      )}

      {/* Relationships */}
      <SectionLabel>Relationships · {relationships.length}</SectionLabel>
      <div className="space-y-2 pb-2">
        {relationships.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onNavigate(r.other.id)}
            className="group flex w-full items-start gap-2 rounded-lg border border-panel-border bg-[rgba(8,20,38,0.4)] p-2.5 text-left transition-all duration-200 hover:translate-x-1 hover:border-panel-hot hover:shadow-glow-arc"
          >
            <SynapseTag label={r.type} color={EDGE_COLORS[r.type]} dot={false} />
            <span
              className="mt-0.5 flex items-center gap-1 font-mono text-[10px] uppercase"
              style={{ color: r.direction === 'out' ? 'var(--arc)' : '#b26bff' }}
            >
              {r.direction === 'out' ? <ArrowUpRight size={12} /> : <ArrowDownLeft size={12} />}
              {r.direction}
            </span>
            <span className="line-clamp-2 flex-1 text-[12px] leading-snug text-mid group-hover:text-hi">
              {r.other.content}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * NodeDetailDrawer — design.md §7.9 (right side, 400px, solid holo-panel).
 * Used on home + memories pages.
 */
export default function NodeDetailDrawer({
  memoryId,
  onClose,
  onNavigate,
  className,
}: {
  memoryId: string | null;
  onClose: () => void;
  onNavigate: (id: string) => void;
  className?: string;
}) {
  const memory = memoryId ? getMemory(memoryId) : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <AnimatePresence>
      {memory && (
        <motion.aside
          key={memory.id}
          initial={{ x: '100%', opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: '100%', opacity: 0 }}
          transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
          className={cn('w-[400px] max-w-[90vw] shrink-0', className)}
        >
          <HoloPanel variant="solid" corners className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-panel-border px-4 py-2.5">
              <span className="font-display text-[12px] font-bold tracking-[0.14em] text-hi">
                ENGRAM DETAIL
              </span>
              <button
                type="button"
                aria-label="Close drawer"
                onClick={onClose}
                className="text-dim transition-colors hover:text-arc"
              >
                <X size={16} />
              </button>
            </div>
            <motion.div
              key={`body-${memory.id}`}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className="min-h-0 flex-1 overflow-y-auto p-4"
            >
              <DrawerBody memory={memory} onNavigate={onNavigate} />
            </motion.div>
          </HoloPanel>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
