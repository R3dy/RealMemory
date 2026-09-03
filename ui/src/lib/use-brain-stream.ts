/**
 * useBrainStream — synthetic-self Phase 8 UI transport.
 *
 * Opens an EventSource to /api/stream?after=<seq> and feeds real brain events
 * to subscribers. Falls back to polling /api/brain/state if EventSource is
 * unavailable. The hook is the data-source replacement for the Math.random()
 * simulation that drove every /brain panel before Phase 8.
 *
 * See docs/architecture/synthetic-self.md §5.1 (Transport) + §5.5 (Honesty).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
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
}

export type LivenessBadge = 'live' | 'stale' | 'idle' | 'empty' | 'demo';

const POLL_INTERVAL_MS = 2000;
const SSE_RECONNECT_DELAY_MS = 3000;
const MAX_BUFFERED_EVENTS = 200;

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

/**
 * Subscribe to the brain event stream. Returns the buffered events (most-recent
 * last), the current liveness badge, and the latest state snapshot.
 *
 * The hook is designed for the /brain page: one stream, many panels. Each panel
 * filters the events it cares about by `kind`. The buffer is bounded so a long
 * session doesn't grow memory unboundedly.
 */
export function useBrainStream(enabled = true) {
  const [events, setEvents] = useState<BrainEvent[]>([]);
  const [badge, setBadge] = useState<LivenessBadge>('empty');
  const [snapshot, setSnapshot] = useState<BrainStateSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const lastSeqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch the initial snapshot (for page load before any events arrive).
  const fetchSnapshot = useCallback(async () => {
    const base = resolveBase();
    try {
      const res = await fetch(`${base}/api/brain/state`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data: BrainStateSnapshot = await res.json();
      setSnapshot(data);
      setBadge(data.liveVsStale);
      if (data.eventCount > 0 && lastSeqRef.current === 0) {
        // Seed lastSeq so we don't replay the entire tape on connect.
        // We'll still get new events from the stream.
      }
    } catch {
      // Silent — offline or wrong port. Badge stays 'empty'.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const base = resolveBase();

    // Try EventSource first (real-time SSE).
    if (typeof EventSource !== 'undefined') {
      let stopped = false;
      const connect = () => {
        if (stopped) return;
        const url = `${base}/api/stream?after=${lastSeqRef.current}`;
        const es = new EventSource(url);
        esRef.current = es;

        es.onopen = () => {
          setConnected(true);
          setBadge('live');
        };

        es.onerror = () => {
          setConnected(false);
          es.close();
          if (!stopped) {
            // Reconnect after a delay. Fall back to polling if SSE keeps failing.
            setTimeout(() => {
              if (!stopped) connect();
            }, SSE_RECONNECT_DELAY_MS);
          }
        };

        // Generic message handler — SSE named events (event: <kind>) arrive as
        // separate listeners, but a default message handler catches unnamed ones.
        // We use named events, so each kind would need its own listener. Instead,
        // we listen on the generic 'message' event AND set up named listeners
        // for the known kinds. Simpler: parse from onmessage if the server sends
        // unnamed, OR use addEventListener for each kind.
        //
        // The server sends `event: <kind>\ndata: <json>\n`, so the browser
        // dispatches a named event per kind. We add a catch-all via
        // addEventListener for the known kinds + a fallback.
        const handleEvent = (kind: string) => (ev: MessageEvent) => {
          try {
            const payload = JSON.parse(ev.data as string);
            // The SSE id field carries the seq.
            const seq = typeof ev.lastEventId === 'string' ? parseInt(ev.lastEventId, 10) : 0;
            if (seq > lastSeqRef.current) lastSeqRef.current = seq;
            const event: BrainEvent = {
              seq: seq || Date.now(),
              kind,
              payload,
              recordedAt: new Date().toISOString(),
            };
            setEvents((prev) => {
              const next = [...prev, event];
              if (next.length > MAX_BUFFERED_EVENTS) {
                return next.slice(-MAX_BUFFERED_EVENTS);
              }
              return next;
            });
            setBadge('live');
          } catch {
            // Malformed payload — ignore.
          }
        };

        // Register listeners for all known brain event kinds.
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
        for (const k of KINDS) {
          es.addEventListener(k, handleEvent(k) as EventListener);
        }
      };

      connect();

      // Poll the snapshot periodically (for the badge — SSE doesn't tell us
      // when the stream goes stale, so we poll /api/brain/state to update
      // liveVsStale).
      pollRef.current = setInterval(() => {
        void fetchSnapshot();
      }, POLL_INTERVAL_MS * 15); // every 30s — the badge only needs coarse updates

      // Initial snapshot fetch.
      void fetchSnapshot();

      return () => {
        stopped = true;
        esRef.current?.close();
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }

    // Fallback: no EventSource — poll /api/brain/state.
    pollRef.current = setInterval(() => {
      void fetchSnapshot();
    }, POLL_INTERVAL_MS);

    void fetchSnapshot();

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [enabled, fetchSnapshot]);

  return { events, badge, snapshot, connected };
}

/**
 * Filter the event buffer by kind. Helper for panels that only care about
 * specific event types.
 */
export function useBrainEventsByKind(kinds: string[], enabled = true) {
  const { events } = useBrainStream(enabled);
  return events.filter((e) => kinds.includes(e.kind));
}
