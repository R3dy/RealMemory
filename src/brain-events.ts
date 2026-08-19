/**
 * Brain event spine (synthetic-self Phase 8).
 *
 * The plugin process and the web UI server process do not share RAM. This
 * module is the bridge: the reflex/deliberative paths emit brain events into
 * an in-RAM ring buffer (zero I/O), and `flush()` periodically drains the ring
 * into the `brain_events` SQLite table in a detached batched INSERT. The UI
 * server tails that table over SSE so the `/brain` page renders real activity
 * instead of `Math.random()`.
 *
 * ADR-010 (two-pathway) is sacred: `emit()` is an array push + a counter — no
 * I/O, no await, <5ms. `flush()` is always called from the deliberative path
 * (`tool.execute.after`, `session.idle`, `session.compacting`).
 *
 * See `docs/architecture/synthetic-self.md` §4 Phase 8 for the full design.
 */

import type { MemoryStore } from "./store";

/** A brain event kind. v1 of the event spine. */
export type BrainEventKind =
  | "perceive.intent"
  | "reflex.fire"
  | "reflex.rewrite"
  | "reflex.block"
  | "reflex.override"
  | "predict.made"
  | "predict.resolved"
  | "wm.assembled"
  | "encode.stored"
  | "encode.reinforced"
  | "consolidate.cluster"
  | "decay.run"
  | "arousal.change";

/** All v1 event kinds. Used for validation + docs. */
export const BRAIN_EVENT_KINDS: readonly BrainEventKind[] = [
  "perceive.intent",
  "reflex.fire",
  "reflex.rewrite",
  "reflex.block",
  "reflex.override",
  "predict.made",
  "predict.resolved",
  "wm.assembled",
  "encode.stored",
  "encode.reinforced",
  "consolidate.cluster",
  "decay.run",
  "arousal.change",
] as const;

const KIND_SET: ReadonlySet<string> = new Set(BRAIN_EVENT_KINDS);

/** A pending brain event in the in-RAM ring buffer. */
export interface PendingBrainEvent {
  kind: BrainEventKind;
  /** JSON-serializable payload. Stored as TEXT in `brain_events.payload`. */
  payload: Record<string, unknown>;
  /** ISO timestamp captured at emit time (flush records the ring-buffer age). */
  emittedAt: string;
  /** Optional session id; written to `brain_events.session_id`. */
  sessionId?: string;
}

/** The in-RAM ring buffer. Bounded; drop-oldest on overflow. */
interface BrainEventRing {
  buf: PendingBrainEvent[];
  head: number; // index of the oldest entry
  count: number;
  dropped: number; // events lost to ring overflow since last flush reset
  lastFlushAt: number; // epoch ms of the most recent flush (for p95 lag)
  flushLags: number[]; // recent flush-lag samples (ms) for --doctor p95
  enabled: boolean; // gate: brain.events !== false
  retention: number; // brain.eventRetention (delete below max(seq) - retention)
  seq: number; // monotonic in-process seq for ordering before any flush
}

/** Module-level singleton ring. Created lazily on first emit/flush. */
let ring: BrainEventRing | null = null;

/** Default ring capacity (drop-oldest once full). */
const RING_CAPACITY = 512;

/** Default retention cap. Each flush deletes rows below max(seq) - retention. */
const DEFAULT_RETENTION = 20000;

/** Cap on the flush-lag samples kept for --doctor p95 reporting. */
const MAX_LAG_SAMPLES = 128;

/**
 * Initialize (or reconfigure) the ring. Called by the plugin at session start
 * once config is loaded. Idempotent: re-calling with new config updates the
 * gates without losing buffered events.
 */
export function configureBrainEvents(opts: {
  enabled: boolean;
  retention: number;
  capacity?: number;
}): void {
  const capacity = opts.capacity ?? RING_CAPACITY;
  if (!ring) {
    ring = {
      buf: new Array(capacity),
      head: 0,
      count: 0,
      dropped: 0,
      lastFlushAt: 0,
      flushLags: [],
      enabled: opts.enabled,
      retention: opts.retention,
      seq: 0,
    };
    return;
  }
  ring.enabled = opts.enabled;
  ring.retention = opts.retention;
  // Capacity change: preserve count, truncate if shrinking.
  if (ring.buf.length !== capacity) {
    const preserved = drainRingUnsafe(ring).slice(0, capacity);
    ring.buf = new Array(capacity);
    for (let i = 0; i < preserved.length; i++) ring.buf[i] = preserved[i];
    ring.head = 0;
    ring.count = preserved.length;
  }
}

/**
 * Emit a brain event. **Zero I/O** — pushes onto the in-RAM ring and returns.
 * Called from the reflex path (ADR-010 <5ms budget): an array write + a
 * counter + a Date.now(). No await, no throw on a bad kind (validated +
 * dropped with a console.error, never propagated to the caller).
 *
 * Returns true if the event was buffered, false if dropped (disabled, invalid
 * kind, or ring overflow). Callers may ignore the return value.
 */
export function emit(
  kind: BrainEventKind,
  payload: Record<string, unknown> = {},
  sessionId?: string,
): boolean {
  if (!ring || !ring.enabled) return false;
  if (!KIND_SET.has(kind)) {
    // Defensive: a typo'd kind must never throw on the reflex path.
    // eslint-disable-next-line no-console
    console.error(`[realmemory] brain-events: unknown kind "${kind}" (dropped)`);
    return false;
  }
  const event: PendingBrainEvent = {
    kind,
    payload,
    emittedAt: new Date().toISOString(),
    sessionId,
  };
  if (ring.count < ring.buf.length) {
    ring.buf[(ring.head + ring.count) % ring.buf.length] = event;
    ring.count++;
  } else {
    // Drop-oldest: overwrite the head, advance it.
    ring.buf[ring.head] = event;
    ring.head = (ring.head + 1) % ring.buf.length;
    ring.dropped++;
  }
  ring.seq++;
  return true;
}

/** Whether the ring is enabled (brain.events !== false). */
export function isEnabled(): boolean {
  return ring?.enabled ?? false;
}

/** Number of events currently buffered in the ring (unflushed). */
export function pendingCount(): number {
  return ring?.count ?? 0;
}

/** Number of events dropped to ring overflow since the process started. */
export function droppedCount(): number {
  return ring?.dropped ?? 0;
}

/** The most recent flush-lag samples (ms), oldest-first, capped. */
export function flushLagSamples(): number[] {
  return ring ? ring.flushLags.slice() : [];
}

/**
 * Drain the ring into a flat array (oldest-first) and reset count/head.
 * Does NOT touch `dropped` (that's a cumulative process counter).
 */
function drainRingUnsafe(r: BrainEventRing): PendingBrainEvent[] {
  const out: PendingBrainEvent[] = [];
  for (let i = 0; i < r.count; i++) {
    out.push(r.buf[(r.head + i) % r.buf.length]!);
  }
  r.head = 0;
  r.count = 0;
  return out;
}

/**
 * Flush the in-RAM ring into the `brain_events` SQLite table. Detached +
 * batched — called from the deliberative path only (`tool.execute.after`,
 * `session.idle`, `session.compacting`). No timer in the agent process.
 *
 * Performs a single multi-row INSERT (transactional via better-sqlite3's
 * implicit batching) then deletes rows below `max(seq) - retention` to cap
 * the tape. Records a flush-lag sample (ring-buffer age) for --doctor p95.
 *
 * Returns the number of events inserted. Safe to call when disabled (no-op,
 * returns 0) or when the store is unavailable (logs + returns 0).
 */
export async function flush(store: MemoryStore): Promise<number> {
  if (!ring || !ring.enabled || ring.count === 0) return 0;
  const events = drainRingUnsafe(ring);
  if (events.length === 0) return 0;
  // Flush lag: age of the oldest event in this batch (ms). Used for --doctor p95.
  let lag = 0;
  try {
    const oldestMs = Date.parse(events[0]!.emittedAt);
    if (!Number.isNaN(oldestMs)) lag = Date.now() - oldestMs;
  } catch {
    // ignore — a bad timestamp must never block a flush
  }
  try {
    const inserted = await store.insertBrainEvents(events);
    // Retention cap: delete rows below max(seq) - retention.
    if (ring.retention > 0) {
      await store.capBrainEvents(ring.retention);
    }
    ring.lastFlushAt = Date.now();
    ring.flushLags.push(lag);
    if (ring.flushLags.length > MAX_LAG_SAMPLES) ring.flushLags.shift();
    return inserted;
  } catch (err) {
    // A flush failure must never break the deliberative path (INV-017 spirit).
    // Re-buffer the events at the tail so they survive a transient store error.
    // eslint-disable-next-line no-console
    console.error(
      `[realmemory] brain-events flush failed: ${err instanceof Error ? err.message : String(err)} (re-buffering ${events.length} events)`,
    );
    for (const e of events) {
      if (ring.count < ring.buf.length) {
        ring.buf[(ring.head + ring.count) % ring.buf.length] = e;
        ring.count++;
      } else {
        ring.buf[ring.head] = e;
        ring.head = (ring.head + 1) % ring.buf.length;
        ring.dropped++;
      }
    }
    return 0;
  }
}

/** Reset the ring state. Test-only — not exported via the public API. */
export function __resetForTests(): void {
  ring = null;
}

/** Default retention (exported for config validation + tests). */
export const DEFAULT_EVENT_RETENTION = DEFAULT_RETENTION;
