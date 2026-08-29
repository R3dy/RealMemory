/**
 * Brain stream store — issue #62 (shared singleton stream + tail seeding +
 * batched flush). Pure TS tests: no DOM, injectable EventSource/clock.
 *
 * Test numbering follows the plan (§4 Story A62.2 tests 1-13).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createBrainStreamStore,
  filterEventsByKind,
  type BrainStreamStoreOptions,
  type BrainStateSnapshot,
  type BrainEvent,
  type EventSourceLike,
} from '../ui/src/lib/use-brain-stream';

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners = new Map<string, Array<(ev: { data?: string; lastEventId?: string }) => void>>();
  onopen: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: { data?: string; lastEventId?: string }) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }

  close(): void {
    this.closed = true;
  }

  // Test helpers
  emit(kind: string, data: string, id: string): void {
    for (const cb of this.listeners.get(kind) ?? []) cb({ data, lastEventId: id });
  }

  fail(): void {
    this.onerror?.();
  }

  open(): void {
    this.onopen?.();
  }
}

function snap(lastSeq: number): BrainStateSnapshot {
  return {
    lastEventAt: null,
    liveVsStale: 'idle',
    reflexRuleCount: 0,
    lastArousal: null,
    lastWmAssembled: null,
    eventCount: lastSeq,
    lastSeq,
  };
}

function evt(seq: number, kind = 'predict.made'): BrainEvent {
  return { seq, kind, payload: {}, recordedAt: new Date().toISOString() };
}

function makeStore(over: Partial<BrainStreamStoreOptions> = {}) {
  FakeEventSource.instances = [];
  return createBrainStreamStore({
    createEventSource: (url) => new FakeEventSource(url),
    onPageHide: () => {},
    fetchState: async () => null,
    ...over,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('brain stream store — flood batching (test #1)', () => {
  it('delivers 100 pushed events as exactly ONE notification on flush', () => {
    const store = makeStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    for (let i = 1; i <= 100; i++) store.pushEvent(evt(i));
    store.flush();
    expect(notifications).toBe(1);
    expect(store.getSnapshot().events).toHaveLength(100);
    expect(store.getSnapshot().badge).toBe('live');
    // A second flush with nothing pending is a no-op.
    store.flush();
    expect(notifications).toBe(1);
  });
});

describe('brain stream store — ring cap (test #2)', () => {
  it('never exceeds maxBuffered and keeps the most recent events', () => {
    const store = makeStore({ maxBuffered: 200 });
    for (let i = 1; i <= 250; i++) store.pushEvent(evt(i));
    store.flush();
    const events = store.getSnapshot().events;
    expect(events).toHaveLength(200);
    expect(events[0]!.seq).toBe(51);
    expect(events[199]!.seq).toBe(250);
  });
});

describe('brain stream store — tail seeding (test #3)', () => {
  it('opens the stream at the seeded tail, never at 0 when the tape is nonempty', () => {
    const store = makeStore();
    store.start({ base: 'http://x', initialSnapshot: snap(28227) });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe('http://x/api/stream?after=28227');
  });

  it('opens at after=0 on an empty tape', () => {
    const store = makeStore();
    store.start({ base: 'http://x', initialSnapshot: snap(0) });
    expect(FakeEventSource.instances[0]!.url).toBe('http://x/api/stream?after=0');
  });
});

describe('brain stream store — monotonic lastSeq (test #4)', () => {
  it('advances across pushes regardless of arrival order', () => {
    const store = makeStore();
    store.start({ base: 'http://x', initialSnapshot: snap(5) });
    store.pushEvent(evt(10));
    store.pushEvent(evt(7));
    store.pushEvent(evt(20));
    expect(store.getLastSeq()).toBe(20);
  });
});

describe('brain stream store — snapshot reference stability (tests #5 + #13)', () => {
  it('getSnapshot returns the identical reference before start and across no-op flushes', () => {
    const store = makeStore();
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before); // pre-start (test #13)
    store.start({ base: 'http://x', initialSnapshot: snap(0) });
    const started = store.getSnapshot();
    store.flush(); // nothing pending — no-op
    expect(store.getSnapshot()).toBe(started);
    store.pushEvent(evt(1));
    store.flush();
    expect(store.getSnapshot()).not.toBe(started); // real flush reassigns once
    const after = store.getSnapshot();
    store.flush();
    expect(store.getSnapshot()).toBe(after);
  });
});

describe('brain stream store — unsubscribe (test #6)', () => {
  it('stops notifying after unsubscribe', () => {
    const store = makeStore();
    let calls = 0;
    const unsub = store.subscribe(() => {
      calls += 1;
    });
    store.pushEvent(evt(1));
    store.flush();
    expect(calls).toBe(1);
    unsub();
    store.pushEvent(evt(2));
    store.flush();
    expect(calls).toBe(1);
  });
});

describe('brain stream store — filter helper (test #7)', () => {
  it('filters events by kind', () => {
    const events = [evt(1, 'predict.made'), evt(2, 'arousal.change'), evt(3, 'predict.made')];
    const out = filterEventsByKind(events, ['predict.made']);
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.kind === 'predict.made')).toBe(true);
    expect(filterEventsByKind(events, [])).toHaveLength(0);
  });
});

describe('brain stream store — reconnect resumes from the tail (test #8)', () => {
  it('reconnects with after=<current lastSeq>, never 0 or the original seed', () => {
    const store = makeStore();
    store.start({ base: 'http://x', initialSnapshot: snap(100) });
    const es1 = FakeEventSource.instances[0]!;
    es1.open();
    // Live events advance the tail.
    es1.emit('predict.made', '{}', '150');
    es1.emit('wm.assembled', '{}', '160');
    expect(store.getLastSeq()).toBe(160);
    es1.fail();
    expect(store.getSnapshot().connected).toBe(false);
    expect(es1.closed).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(FakeEventSource.instances).toHaveLength(2);
    const es2 = FakeEventSource.instances[1]!;
    expect(es2.url).toBe('http://x/api/stream?after=160');
  });
});

describe('brain stream store — stop() cleanup (test #9)', () => {
  it('clears the flush timer, closes the stream, and stops notifications', () => {
    const store = makeStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.start({ base: 'http://x', initialSnapshot: snap(0) });
    store.stop();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(store.isStarted()).toBe(false);
    // Flush timer dead: pending events are never delivered after stop.
    store.pushEvent(evt(1));
    vi.advanceTimersByTime(60_000);
    expect(notifications).toBe(2); // start's applySnapshot + stop()'s teardown notify
    expect(store.getSnapshot().events).toHaveLength(0);
    // restart works and opens a fresh connection from the current tail
    store.start({ base: 'http://x', initialSnapshot: snap(0) });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(store.isStarted()).toBe(true);
  });
});

describe('brain stream store — malformed payload (test #10)', () => {
  it('silently ignores unparseable event data without state change or throw', () => {
    const store = makeStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.start({ base: 'http://x', initialSnapshot: snap(0) });
    const es = FakeEventSource.instances[0]!;
    expect(() => es.emit('predict.made', 'not-json{', '5')).not.toThrow();
    es.emit('predict.made', '{"ok":true}', '6');
    vi.advanceTimersByTime(250);
    expect(notifications).toBe(2); // start's applySnapshot + the flush delivering seq 6
    expect(store.getSnapshot().events).toHaveLength(1);
    expect(store.getSnapshot().events[0]!.seq).toBe(6);
  });
});

describe('brain stream store — start lifecycle (test #11)', () => {
  it('does not connect until started; start is idempotent', () => {
    const store = makeStore();
    expect(store.isStarted()).toBe(false);
    expect(store.connectionCount()).toBe(0);
    store.start({ base: 'http://x', initialSnapshot: snap(0) });
    expect(store.isStarted()).toBe(true);
    expect(store.connectionCount()).toBe(1);
    store.start({ base: 'http://x', initialSnapshot: snap(9) }); // racing second call
    expect(store.connectionCount()).toBe(1);
    expect(store.getLastSeq()).toBe(0); // the late seed did not clobber state
  });
});

describe('brain stream store — poll-lastSeq seeding rule (test #12)', () => {
  it('advances the seed only while disconnected; ignores it while connected', () => {
    const store = makeStore();
    // Disconnected: snapshot refines the seed for the next connect.
    store.applySnapshot(snap(30000));
    expect(store.getLastSeq()).toBe(30000);
    store.start({ base: 'http://x', initialSnapshot: undefined });
    expect(FakeEventSource.instances[0]!.url).toBe('http://x/api/stream?after=30000');
    // Connected: a higher poll lastSeq must NOT reseed or reconnect.
    const es = FakeEventSource.instances[0]!;
    es.open();
    store.applySnapshot(snap(40000));
    expect(store.getLastSeq()).toBe(30000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
