/**
 * useBrainStream — synthetic-self Phase 8 UI transport.
 *
 * ONE shared stream, many panels (issue #62 fix). The stream is a module-level
 * singleton store: one EventSource for the whole page regardless of how many
 * components subscribe, connected at the LIVE TAIL (seeded from
 * /api/brain/state's lastSeq — never replays the brain_events tape), with
 * batched delivery (a 250ms flush notifies React at most ~4x/sec instead of
 * per-event setState at up to ~7,200/sec — the flicker/blackout storm).
 *
 * Semantics (issue #62 plan §F2):
 *   - State object created once; getSnapshot() returns the cached reference on
 *     every call (stable before start(), between no-op flushes). Transitions
 *     reassign immutably; a flush with nothing to deliver is a no-op.
 *   - pushEvent() buffers into `pending`; flush() drains it into the bounded
 *     ring (max 200) and notifies subscribers once.
 *   - Tail seeding: start({base, initialSnapshot}) seeds lastSeq from the
 *     snapshot's lastSeq BEFORE opening `/api/stream?after=<lastSeq>`.
 *     The 30s snapshot poll refines the seed ONLY while disconnected (while
 *     connected the stream is already tailing — a higher poll value must not
 *     trigger a reconnect).
 *   - Reconnect (3s backoff on ES error) resumes from the current lastSeq.
 *   - Navigation lifecycle: the singleton persists across route changes;
 *     a React unmount only unsubscribes the component listener. stop()
 *     (flush timer + EventSource close) happens on page unload/pagehide or
 *     explicit teardown only; start() after stop() resumes from lastSeq.
 *
 * See docs/architecture/synthetic-self.md §5.1 (Transport) + §5.5 (Honesty).
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { DEFAULT_API_BASE } from './data';

export interface BrainEvent {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  recordedAt: string;
}

export interface BrainStateSnapshot {
  lastEventAt: string | null;
  liveVsStale: 'live' | 'stale' | 'idle' | 'empty';
  reflexRuleCount: number;
  lastArousal: number | null;
  lastWmAssembled: Record<string, unknown> | null;
  eventCount: number;
  lastSeq: number;
}

export type LivenessBadge = 'live' | 'stale' | 'idle' | 'empty' | 'demo';

const FLUSH_INTERVAL_MS = 250;
const SSE_RECONNECT_DELAY_MS = 3000;
const BADGE_POLL_MS = 30_000;
const MAX_BUFFERED_EVENTS = 200;

/** Minimal EventSource surface the store needs (injectable for tests). */
export interface EventSourceLike {
  addEventListener(type: string, cb: (ev: { data?: string; lastEventId?: string }) => void): void;
  onopen: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  close(): void;
}

export interface BrainStreamState {
  events: BrainEvent[];
  badge: LivenessBadge;
  snapshot: BrainStateSnapshot | null;
  connected: boolean;
}

export interface BrainStreamStoreOptions {
  flushIntervalMs?: number;
  maxBuffered?: number;
  /** Fetch /api/brain/state (injectable for tests). */
  fetchState?: (base: string) => Promise<BrainStateSnapshot | null>;
  /** EventSource factory (injectable for tests). */
  createEventSource?: (url: string) => EventSourceLike;
  /** Register the page-unload stop hook (injectable for tests). */
  onPageHide?: (fn: () => void) => void;
}

export interface BrainStreamStore {
  subscribe(fn: () => void): () => void;
  getSnapshot(): BrainStreamState;
  /** Seed + open the stream. Idempotent; safe to call again after stop(). */
  start(opts: { base: string; initialSnapshot?: BrainStateSnapshot | null }): void;
  /** Flush timer + EventSource + poll teardown (page unload / test teardown only). */
  stop(): void;
  /** Buffer one event; delivered to subscribers on the next flush. */
  pushEvent(ev: BrainEvent): void;
  /** Drain pending into the bounded ring; notify once. No-op when nothing changed. */
  flush(): void;
  /** Apply a /api/brain/state snapshot (badge + snapshot state; seeds tail while disconnected). */
  applySnapshot(snap: BrainStateSnapshot): void;
  /** Test/debug accessors. */
  getLastSeq(): number;
  isStarted(): boolean;
  connectionCount(): number;
}

const KINDS = [
  'perceive.intent',
  'reflex.fire',
  'reflex.rewrite',
  'reflex.block',
  'reflex.override',
  'predict.made',
  'predict.resolved',
  'wm.assembled',
  'encode.stored',
  'encode.reinforced',
  'consolidate.cluster',
  'decay.run',
  'arousal.change',
];

export function createBrainStreamStore(opts: BrainStreamStoreOptions = {}): BrainStreamStore {
  const flushIntervalMs = opts.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const maxBuffered = opts.maxBuffered ?? MAX_BUFFERED_EVENTS;

  const fetchState =
    opts.fetchState ??
    (async (base: string) => {
      try {
        const res = await fetch(`${base}/api/brain/state`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return null;
        return (await res.json()) as BrainStateSnapshot;
      } catch {
        return null;
      }
    });

  const createEventSource =
    opts.createEventSource ??
    ((url: string) => new EventSource(url) as unknown as EventSourceLike);

  const onPageHide =
    opts.onPageHide ??
    ((fn: () => void) => {
      if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', fn, { once: true });
        window.addEventListener('beforeunload', fn, { once: true });
      }
    });

  // State object created ONCE — stable reference for getSnapshot() before
  // start() and between no-op flushes (R2-C1 / test #13).
  let state: BrainStreamState = {
    events: [],
    badge: 'empty',
    snapshot: null,
    connected: false,
  };
  const subscribers = new Set<() => void>();

  let started = false;
  let stopped = false;
  let lastSeq = 0;
  let base = '';
  let es: EventSourceLike | null = null;
  let connections = 0;
  let pending: BrainEvent[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const notify = (): void => {
    for (const fn of subscribers) fn();
  };

  const connect = (): void => {
    if (stopped) return;
    const url = `${base}/api/stream?after=${lastSeq}`;
    const source = createEventSource(url);
    es = source;
    connections += 1;

    source.onopen = () => {
      if (stopped) return;
      state = { ...state, connected: true, badge: 'live' };
      notify();
    };

    source.onerror = () => {
      if (stopped) return;
      state = { ...state, connected: false };
      notify();
      source.close();
      if (es === source) es = null;
      // Reconnect after a delay, resuming from the current tail position —
      // never from 0, never a replay (R1-C3 / test #8).
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, SSE_RECONNECT_DELAY_MS);
    };

    const handleEvent = (kind: string) => (ev: { data?: string; lastEventId?: string }) => {
      try {
        const payload = JSON.parse(ev.data ?? '{}') as Record<string, unknown>;
        const seq =
          typeof ev.lastEventId === 'string' ? parseInt(ev.lastEventId, 10) : 0;
        const event: BrainEvent = {
          seq: seq || Date.now(),
          kind,
          payload,
          recordedAt: new Date().toISOString(),
        };
        pushEvent(event);
      } catch {
        // Malformed payload — silently ignored (R1-C5 / test #10).
      }
    };
    for (const k of KINDS) source.addEventListener(k, handleEvent(k));
  };

  const pushEvent = (ev: BrainEvent): void => {
    if (ev.seq > lastSeq) lastSeq = ev.seq;
    pending.push(ev);
  };

  const flush = (): void => {
    if (pending.length === 0) {
      // No-op flush: state reference unchanged (R2-C1 / test #5).
      return;
    }
    const events = [...state.events, ...pending].slice(-maxBuffered);
    pending = [];
    state = { ...state, events, badge: 'live' };
    notify();
  };

  const applySnapshot = (snap: BrainStateSnapshot): void => {
    // Seed the tail position from the snapshot ONLY while disconnected (R2-C2 /
    // test #12): while connected the stream is already tailing, and a higher
    // poll value must not trigger a reconnect.
    if (!state.connected && !es && snap.lastSeq > lastSeq) {
      lastSeq = snap.lastSeq;
    }
    state = { ...state, snapshot: snap, badge: state.connected ? state.badge : snap.liveVsStale };
    notify();
  };

  const start = (startOpts: { base: string; initialSnapshot?: BrainStateSnapshot | null }): void => {
    if (started) return;
    started = true;
    stopped = false;
    base = startOpts.base;
    // Seed the tail position BEFORE opening the stream (F1 — the flood killer).
    if (startOpts.initialSnapshot) applySnapshot(startOpts.initialSnapshot);
    connect();
    flushTimer = setInterval(flush, flushIntervalMs);
    // Coarse badge refresh — SSE doesn't report staleness on its own.
    pollTimer = setInterval(() => {
      void fetchState(base).then((snap) => {
        if (snap && !stopped) applySnapshot(snap);
      });
    }, BADGE_POLL_MS);
    onPageHide(() => stop());
  };

  const stop = (): void => {
    if (!started) return;
    stopped = true;
    started = false; // start() may run again later (navigation back, tests)
    if (es) {
      try {
        es.close();
      } catch {
        /* already closed */
      }
      es = null;
    }
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    pending = [];
    state = { ...state, connected: false };
    notify();
  };

  return {
    subscribe(fn: () => void): () => void {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    getSnapshot(): BrainStreamState {
      return state;
    },
    start,
    stop,
    pushEvent,
    flush,
    applySnapshot,
    getLastSeq: () => lastSeq,
    isStarted: () => started,
    connectionCount: () => connections,
  };
}

function resolveBase(): string {
  // Same resolution logic as data.ts — relative by default, ?api= override, localStorage fallback.
  try {
    const q = new URLSearchParams(window.location.search).get('api');
    if (q) return q.replace(/\/+$/, '');
  } catch {
    /* no window */
  }
  try {
    const stored = window.localStorage.getItem('realmemory.apiBase');
    if (stored) {
      if (stored.startsWith('http://') && window.location.protocol === 'https:') {
        return DEFAULT_API_BASE;
      }
      return stored.replace(/\/+$/, '');
    }
  } catch {
    /* private mode */
  }
  return DEFAULT_API_BASE;
}

/** Fetch /api/brain/state (real implementation, used by the singleton). */
async function fetchSnapshot(base: string): Promise<BrainStateSnapshot | null> {
  try {
    const res = await fetch(`${base}/api/brain/state`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as BrainStateSnapshot;
  } catch {
    return null;
  }
}

// Module-level singleton — ONE stream for the whole page (F2). start() is
// idempotent via the started flag, so concurrent mount effects and re-mounts
// are safe (no StrictMode dependence). In tests, createBrainStreamStore()
// directly for an isolated instance.
const sharedStore = createBrainStreamStore({ fetchState: fetchSnapshot });

/**
 * Subscribe to the shared brain event stream. Returns the buffered events
 * (most-recent last), the current liveness badge, and the latest snapshot.
 *
 * Every caller shares ONE EventSource connection and ONE bounded buffer;
 * updates are batched (≤ ~4 notifications/sec) — see issue #62.
 */
export function useBrainStream(enabled = true) {
  const state = useSyncExternalStore(sharedStore.subscribe, sharedStore.getSnapshot);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled && !sharedStore.isStarted()) {
      const base = resolveBase();
      void fetchSnapshot(base).then((snap) => {
        // start() is idempotent — a racing second mount is a no-op.
        if (enabledRef.current && !sharedStore.isStarted()) {
          sharedStore.start({ base, initialSnapshot: snap });
        }
      });
    }
    // React unmount only stops LISTENING (useSyncExternalStore unsubscribe) —
    // the singleton persists across navigation (R2-C4). stop() runs on page
    // unload/pagehide (registered by start()) or explicit teardown.
  }, [enabled]);

  return { events: state.events, badge: state.badge, snapshot: state.snapshot, connected: state.connected };
}

/**
 * Pure selector: filter events by kind (exported for tests; used by
 * useBrainEventsByKind).
 */
export function filterEventsByKind(events: BrainEvent[], kinds: string[]): BrainEvent[] {
  const set = new Set(kinds);
  return events.filter((e) => set.has(e.kind));
}

/**
 * Filter the shared event buffer by kind. A selector over the ONE shared
 * stream — opens NO new connection (issue #62 F2).
 */
export function useBrainEventsByKind(kinds: string[], enabled = true) {
  const { events } = useBrainStream(enabled);
  const key = useMemo(() => kinds.join('\u0000'), [kinds]);
  return useMemo(
    () => filterEventsByKind(events, kinds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, key],
  );
}
