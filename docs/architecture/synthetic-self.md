# Synthetic Self — from a reflex arc to a being with a history

**Status:** design blueprint (not yet implemented)
**Builds on:** `docs/architecture/synthetic-brain.md` (Phases 0–7, all shipped as of v0.15.0)
**Code state analyzed:** `claude/synthetic-brain-thinking-self-2hcjk8` @ `fe4e408`
**Scope:** Phases 8–14 — what has to exist for the agent to have a *self* that develops organically,
and for the UI to show that self changing in real time.

---

## 1. Where Phases 0–7 actually got to

The shipped brain is a working **reflex arc**, and that is not faint praise. Three things in it are
load-bearing and correct:

- **The two-pathway split (ADR-010).** A <5 ms in-RAM reflex path (`matchCall`, `decideAction`)
  beside an unbounded detached deliberative path. This is the decision that lets memory sit in front
  of *actions* rather than only in front of *context*.
- **Inhibition with extinction.** `reflex.ts:315-361` + `plugin.ts:706-745`: a rule fires, the model
  retries the blocked call, confidence drops in RAM *and* in SQLite, and after 1–3 overrides the
  action degrades block → warn. That is operant conditioning, implemented correctly.
- **Surprise as an encoding gate.** `predict.ts` makes storage volume self-limiting instead of
  regex-triggered.

What it does not yet have is a **self**. Concretely, today:

| Faculty | Current state | File |
|---|---|---|
| Identity | One string — the single highest-weight global `user_preference` | `plugin.ts:465-476` |
| Affect | One scalar (arousal), 5-turn window, wiped every session, drives temperature only | `reflex.ts:395-410`, `plugin.ts:428` |
| Abstraction | `synthesizeRule` copies `rep.content` verbatim; "type promotion IS the abstraction" | `consolidate.ts:118` |
| Learning rule | δ computed, used as an encode gate, never written back to any value function | `predict.ts:110-125` |
| Temperament | Module constants, identical for every install, never change | `reflex.ts:66-85`, `config.ts:26-44` |
| Spontaneity | None — every subsystem is hook-triggered; nothing runs during silence | — |
| Metacognition | Metrics recorded, never read by anything that changes behavior | `store.ts:1772` |

And one metric is structurally dead: `evaluateDelta` has a single call site (`plugin.ts:580`) that
always passes `assistantText = ""`, so step 7 records `recall_miss` unconditionally and `recall_hit`
is unreachable. Every phase below that wants to evaluate itself depends on that being honest first.

---

## 2. The three rules this plan is built on

**Rule 1 — a self is a set of dispositions, not a paragraph.** The self is expressed as *what the
agent does at decision points*: what it notices, what it refuses, how hard it pushes, how fast it
forgets. Prose about itself is the smallest and weakest part. Every phase below therefore lands in a
gate, a threshold, or a bias — and only incidentally in text.

**Rule 2 — organic means earned and reversible.** Nothing about the self may be a preset the user
picks. Every trait, every mood, every belief traces to episodes the user can read, and `forget()`
undoes it. A self that cannot be audited is a liability; one that cannot be reverted is a bug.

**Rule 3 — the reflex path stays sacred.** ADR-010 is not negotiable. Nothing in Phases 8–14 adds
I/O, allocation-heavy work, or awaits to `tool.execute.before`, `chat.params`, `tool.definition`, or
`permission.ask`. Everything new is deliberative-path or out-of-process.

---

## 3. The constraint nobody has hit yet: the process boundary

This is the fact that shapes the entire UI half of the plan, and it is not in the Phase 0–7 design
doc.

**The plugin and the web UI do not share a process.** `startBrowserServer` is called from
`mcp-server.ts:441` (side-channel mode) and `bin.ts:80` (standalone `--ui`). The OpenCode plugin
(`plugin.ts`) runs inside the OpenCode host, with its own `MemoryStore` against the same SQLite file.

Consequence: **the UI can never see `state.reflexCache`, `state.workingMemory`,
`state.arousalTracker`, or `state.pendingPredictions`.** All of the interesting brain state is in RAM
in a process the web server has no handle on. It can only see what lands in SQLite.

This explains the current state of `/brain` honestly: every panel on that page —
`BrainLoopPipeline`, `ReflexCore`, `PredictPanel`, `WorkingMemoryWindow`, `BrainCanvas` — drives
itself from `Math.random()`, and the header says "Live Telemetry (Simulated)". The visual design is
excellent and the data is fiction, because with the current architecture there is no other option.

**The fix is an event spine through the database**, not IPC:

```
plugin process                                   ui server process
──────────────                                   ─────────────────
reflex path  ──emit()──▶ RAM ring buffer
                            │ (detached, batched, ≤1/s)
deliberative ──emit()──▶    ▼
                        brain_events (SQLite, WAL, append-only, capped)
                                                     │  tail by seq
                                                     ▼
                                            GET /api/stream  (SSE)
                                                     │
                                                     ▼
                                              live /brain page
```

WAL mode already permits concurrent reads (the README relies on it for the graph browser). SSE needs
nothing beyond `node:http`, which matters because `tests/deps-cap.test.ts` pins the runtime
dependency count at three.

---

## 4. Phases

| Phase | Delivers | New / changed | Default | Risk |
|---|---|---|---|---|
| **8. Event spine + honest telemetry** | Real brain events out of the plugin; the UI stops simulating; `recall_hit` becomes real | `src/brain-events.ts`, schema v5, `browser/server.ts`, all `/brain` panels | **on** | None — observation only. **Blocking prerequisite.** |
| **9. Self-scope memory** | The agent stores facts about itself; identity block is assembled, not queried | `src/self.ts`, `types.ts`, `plugin.ts` | on | Low |
| **10. Trait vector** | Temperament becomes persisted, drifting, bounded, auditable state | `src/traits.ts`, `meta` rows | opt-in | Medium — changes behavior |
| **11. Valence + persistent affect** | Mood survives the night and is domain-specific | `src/affect.ts`, `meta` rows | opt-in | Medium |
| **12. Real abstraction + belief revision** | Episodes become rules that are actually more general; contradictions get resolved | `src/consolidate.ts` rewrite | on (structural) | Medium |
| **13. Reflection (default mode)** | Something happens during silence | `src/reflect.ts` in the UI-server process | **off** | Medium — writes unattended |
| **14. Metacognitive controller** | The system tunes its own config from its own metrics | `src/metacog.ts` | **off** | High |

Each phase is independently shippable and independently valuable. Do not build past a phase whose
eval (below) is red — the same discipline §6 of the Phase 0–7 doc applied to the hook probe.

---

### Phase 8 — Event spine and honest telemetry

**Why first.** Three reasons, any one of which would be sufficient. (1) No later phase can be
evaluated without real signal, and one of the two headline metrics is currently unreachable code.
(2) It is the visible win — `/brain` becomes real without touching agent behavior at all. (3) It is
zero-risk: pure observation, no gate touched.

**Schema v5** (`src/db/schema.ts`, following the existing `MIGRATIONS` map pattern):

```sql
CREATE TABLE IF NOT EXISTS brain_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_events_seq  ON brain_events(seq);
CREATE INDEX IF NOT EXISTS idx_brain_events_kind ON brain_events(kind);
```

Append-only and capped: each flush deletes rows below `max(seq) - BRAIN_EVENT_RETENTION` (default
20 000). This is a telemetry tape, not a record — memories stay in `memories`.

**`src/brain-events.ts`:**

- `emit(kind, payload)` — pushes onto a bounded in-RAM ring (cap 512, drop-oldest, increment a
  `dropped` counter). **Zero I/O.** This is what the reflex path calls, so the <5 ms budget is
  untouched — an array push and a counter.
- `flush(store)` — detached, batched, single multi-row INSERT. Triggered on `tool.execute.after`,
  `session.idle`, and compaction. No timer in the agent process.

**Event kinds (v1):** `perceive.intent`, `reflex.fire`, `reflex.rewrite`, `reflex.block`,
`reflex.override`, `predict.made`, `predict.resolved`, `wm.assembled`, `encode.stored`,
`encode.reinforced`, `consolidate.cluster`, `decay.run`, `arousal.change`. Phases 10–13 add
`trait.drift`, `affect.change`, `belief.revised`, `reflect.*`.

**Server additions** (`src/browser/server.ts`, matching the existing `pathname ===` dispatch):

- `GET /api/stream?after=<seq>` — SSE. Polls `brain_events` for `seq > after` on a 250 ms interval,
  pushes each as a named event, sends a heartbeat comment every 15 s. Localhost-only and read-only,
  same as every other route (ADR-006).
- `GET /api/brain/state` — a snapshot for page load: last known arousal, most recent `wm.assembled`
  payload, reflex rule count, live-vs-stale flag (`now - last event > 5 min` → stale), plus traits
  and affect once those exist. Reconstructed from the event tape, so no shared RAM is required.

**Fix the dead metric.** `plugin.ts:580` should pass real assistant text. `fetchSessionTranscript`
already exists (`plugin.ts:264`) and is already called at idle for the sentinel check and optional
summarization — reuse it. Then compute `recall_hit` properly: fetch the contents of
`lastInjectedMemoryIds` and test for actual token overlap with the assistant's output, instead of the
current "assistantText is non-empty → hit" proxy.

**Eval.** `--doctor` gains an event-spine section: events/min, flush lag p95, dropped count (must be
0 in normal operation), and `recall_hit_rate` reading something other than 0.

---

### Phase 9 — Self-scope memory

Today the agent stores facts about the world and about the user, and has never stored one about
itself.

**New memory type** `self_model` (`types.ts`), with categories `disposition`, `competence`,
`failure_mode`, `commitment`. It is a distinct type rather than a new scope because the existing
`scope: project|global` axis is orthogonal — a self-fact can be project-local ("I keep mis-reading
this repo's test layout") or global ("I reach for bash before reading").

**`src/self.ts` — `recordSelfEpisode(store, state)`**, called on the deliberative path at
`session.idle`. It writes first-person rows from state that already exists in the plugin, no new
perception required:

- prediction record for the session — how often the reflex predictions were right
- every override — "I blocked X and was overruled"
- every high-surprise outcome — "I expected X to work here; it does not"
- tool mix and correction density — "this session I was corrected 4 times in 11 turns"

Content is templated and literal, exactly the discipline `brain-loop.ts` already uses in
`buildContent` — no LLM, no interpretation. These rows deduplicate and reinforce through the existing
`store.store()` path, so a disposition that keeps recurring gains weight naturally instead of
accumulating duplicates.

**Assembled identity.** Replace the single-preference query at `plugin.ts:465-476` with
`assembleIdentity(store, traits, affect)`, returning the tiered block specified in §6.

**Eval.** After two weeks of real use, the identity block's content must differ from what a
`LIMIT 1` preference query returns, and every line must be traceable to ≥ 3 supporting episodes.

---

### Phase 10 — The trait vector

Temperament is currently `BLOCK_SALIENCE_FLOOR = 0.8`, `decayHalfLifeDays: 30`,
`AROUSAL_WEIGHT_CORRECTION = 1.0` — constants, identical everywhere, forever. Personality *is* those
numbers. Make them per-install state that drifts with experience and you have organic personality
almost for free.

**Six traits**, deliberately few, each `0..1` with baseline `0.5`:

| Trait | Rises when | Shifts |
|---|---|---|
| `caution` | corrections, blocks that stuck, high-severity surprises | `BLOCK_SALIENCE_FLOOR`, inhibition escalation |
| `curiosity` | overriding a low-confidence reflex turned out well | P(skip firing a weak reflex) — exploration |
| `skepticism` | duplicate rate high, contradictions found | confidence gain per reinforcement, `duplicateSimilarityThreshold` |
| `tenacity` | old memories keep proving useful on recall | `decayHalfLifeDays` |
| `thoroughness` | recall hits correlate with larger windows | `workingMemoryTokens`, `maxRecallResults` |
| `tempo` | user corrections about verbosity/pace | `concisenessCap` |

**Storage:** a single `meta` row `traits:v1` (JSON). No schema change — `getMeta`/`setMeta` already
exist (`store.ts:1669`).

**Update rule:** EMA with a deliberately tiny learning rate, evaluated **once per session** at idle
(never per turn — per-turn updates make the agent feel unstable):

```
trait ← clamp(0.15, 0.85, trait + α · (observed − trait)),  α ≤ 0.02
```

plus a slow pull toward 0.5 with no supporting evidence, so traits fade rather than lock in. At
α = 0.02 a trait needs on the order of 50 consistent sessions to move meaningfully. That is the
point: this should feel like a personality forming over months, not a slider.

**Wiring rule — traits shift constants within a clamped band, never replace them.** `caution` moves
`BLOCK_SALIENCE_FLOOR` within `0.8 ± 0.1`; `tenacity` moves `decayHalfLifeDays` within `30 ± 10`.
The constants stay the center of the band.

**Hard rule, mirroring the existing arousal rule:** a trait may never move a value the user set
explicitly in config. Only defaults drift.

**Auditability:** every drift emits `trait.drift` and, when it crosses a 0.1 boundary, writes a
`self_model` row — so "why are you like this?" has an answer in the store.

**Eval.** Two installs driven by different task streams for two weeks must show measurably different
trait vectors, and each delta must have a readable causal chain.

---

### Phase 11 — Valence and persistent affect

Arousal exists and answers "how bad", never "bad about what". Add the second axis and make both
survive the session.

**`src/affect.ts`** maintains per-domain `{ valence: -1..1, arousal: 0..1, n, updatedAt }`, stored in
`meta` under `affect:v1`, decaying slowly toward neutral per elapsed day (reuse
`computeRecencyFactor` from `weighting.ts` rather than writing a second decay curve). Domain comes
from the existing `memories.domain` column.

**What affect drives — and only these:**

1. **Recall bias.** Negative-valence domains surface caution rules earlier and at lower thresholds.
   Attention, not mood.
2. **`chat.params`.** Extends the existing arousal→temperature clamp; same ±0.15 ceiling.
3. **Trait updates.** Sustained negative valence in a domain feeds `caution`.
4. **One line of the situational identity tier** (§6): "in this area I have been wrong before."

**What affect must never drive: tone of voice.** An agent that *sounds* frustrated is theater, and it
degrades the product. Affect modulates thresholds; it does not modulate prose. This is the single
most common failure mode of "synthetic personality" projects and the plan rejects it explicitly.

**Eval.** After a domain accumulates ≥ 10 failures, its valence is measurably negative, and recall
in that domain demonstrably surfaces caution rules earlier than in a neutral domain.

---

### Phase 12 — Real abstraction and belief revision

`synthesizeRule` copies the highest-weight episode's content and changes the type. The doc comment is
candid about it — "the type promotion IS the abstraction". The result is a content-duplicate row that
inflates the system's own bloat metric, and no generalization occurs. Without real abstraction there
are no beliefs, and without beliefs there is nothing for a personality to be made of.

**Structural abstraction (default).** For a cluster, extract what the episodes share — common command
prefix, common path segment, common error signature, common tags — and generate a rule whose
*matcher* is broader than any single episode's, with templated content stating the generalization.
Episodes stay attached as `derived_from` children and decay normally. This is mechanical, cheap,
deterministic, and auditable.

**LLM synthesis (opt-in).** `brain.schemaSynthesis: "off" | "structural" | "llm"`, default
`"structural"`. `"llm"` requires `summaryProvider` and runs only on compaction or reflection, never
on any path that can block. Not the default: it is nondeterministic, costs money per consolidation,
and makes the store's contents unauditable — all three matter more than the quality gain here.

**`revisionPass` — the piece that produces beliefs.** Find memory pairs with high similarity but
opposing outcome evidence, create a `contradicts` edge (the machinery exists — `store.relate` already
decays the target's confidence), resolve by recency × confidence × reinforcement, and archive the
loser with a `self_model` note recording the change of mind. An agent that revises beliefs is
categorically different from one that accumulates them.

**Eval.** Rule count tracks the number of distinct true things about the project rather than the
number of events; `memory_bloat_ratio` falls; synthesized rules match calls no single source episode
would have matched.

---

### Phase 13 — Reflection (the default-mode network)

The one thing genuinely absent: nothing happens during silence.

**It runs in the UI-server process, not the plugin.** That process (`browser/server.ts`) is already
long-lived, already holds a store handle, and adding a timer there costs the agent's process nothing.
Putting a background tick inside the OpenCode host would be the wrong trade.

**Tick** when the store has been idle > `reflectIdleMinutes` (default 30), rate-limited through the
existing `maybeDecay`-style meta-key mechanism:

1. Replay the highest-surprise recent episodes; re-cluster them (Phase 12).
2. Run `revisionPass`.
3. Recompute trait and affect drift from accumulated events.
4. Identify stale `codebase_fact` rows whose source files have changed.
5. Generate **questions**, not actions — "is the staging deploy still paused?"

**Products are memories and events only.** No tool call, no file write, no network. Spontaneous
*thinking* is the feature; spontaneous *acting* inside someone's repository is not, and the
distinction is the whole safety story for this phase.

Reflection output surfaces in the next session's working-memory window, hard-capped at one or two
items and dismissible. Default **off** for the first release, because it writes memories unattended.

**Eval.** Reflection-sourced memories must show a *higher* recall-hit rate than the median — if the
agent's idle thoughts are less useful than its reactive ones, the phase has failed and should stay
off.

---

### Phase 14 — The metacognitive controller

Only after Phase 8 makes the metrics honest and Phase 10 supplies the substrate.

A bounded controller reads `recall_hit_rate`, `duplicate_rate`, `memory_bloat_ratio`,
`prediction_error:<bin>`, and `reflex_override` rate, and adjusts `recallThreshold`,
`maxRecallResults`, inhibition ceiling, `workingMemoryTokens`, and `schemaFormationThreshold` — one
parameter at a time, held for K sessions, kept if the target metric improved, reverted otherwise.
Every experiment is an event plus a memory: hypothesis, change, result, verdict.

Default **off**. Ships with `realmemory-mcp --reset-self [--traits|--affect|--identity|--all]`,
which is a hard requirement of Rule 2, not a nice-to-have.

---

## 5. The UI: showing the brain in real time

The goal is a `/brain` page where **every animation is caused by something that actually happened**.
The existing visual design is kept wholesale — this is a data-source replacement, not a redesign.

### 5.1 Transport

`GET /api/stream` (SSE) with `?after=<seq>` resumption, plus `GET /api/brain/state` for the initial
snapshot. Client-side: a small `useBrainStream()` hook over `EventSource` with automatic reconnect
and a bounded client-side buffer. Fallback to polling `/api/brain/state` if `EventSource` is
unavailable. The existing `DEFAULT_API_BASE` / `realmemory.apiBase` mechanism in `ui/src/lib/data.ts`
carries over unchanged.

### 5.2 Rewiring the six existing panels

| Panel | Today | Driven by |
|---|---|---|
| `BrainLoopPipeline` | `pickLane()` over `Math.random()` every 2.5 s | `perceive.intent` — a packet per real turn, real lane counts |
| `ReflexCore` | simulated firing | `reflex.fire` / `.rewrite` / `.block` / `.override`, with the source memory ID clickable through to the row |
| `PredictPanel` | random surprise | `predict.made` → `predict.resolved`, showing the actual δ and which bin it landed in |
| `WorkingMemoryWindow` | placeholder slots | `wm.assembled` — real slot contents, real token counts against the 800 budget, real truncation |
| `ConsolidationPanel` | static | `consolidate.cluster` — clusters forming, `derived_from` edges appearing |
| `ArousalGauge` | random walk | `arousal.change` — the real 5-turn ring buffer value |

### 5.3 The canvas

`BrainCanvas` already maps domains to anatomical regions (`ui/src/lib/domain-regions.ts`). Bind it to
events:

- **Neuron fires** on `encode.stored` / `encode.reinforced` for that memory — one flash, at the node's
  real position.
- **Synapse pulses** along a real edge when `relate` creates one.
- **Region tint = valence, region pulse rate = arousal** (Phase 11). This is the highest-value
  visual in the whole plan: mood rendered as anatomy, and it costs one shader uniform per region.
- **Consolidation storm** during a Phase 12/13 pass — clusters contracting into a new node.
- **Decay** dims and sinks nodes as weight drops, on `decay.run`.

### 5.4 New panels

- **Self** — the assembled identity block exactly as the agent receives it, each line clickable to
  its supporting episodes. "Here is what it believes about itself, and here is why."
- **Traits** — a six-axis radar with a drift sparkline per trait and a "what moved this" drill-down.
- **Affect map** — domains × valence heat over the brain regions, with history.
- **Reflection feed** — what it thought about while you were gone (Phase 13).
- **Controller** — current experiment, hypothesis, and verdict (Phase 14).

### 5.5 Honesty requirements

These are not polish; they follow directly from §6 of the Phase 0–7 doc ("silent degradation is the
single worst failure mode").

- A **LIVE / STALE / DEMO** badge in the header, driven by real event recency. `DEMO` appears only
  when someone explicitly opts into the simulated data source.
- **No-signal states render as no signal.** Panels show "no events yet" rather than idling
  animation. Delete `Math.random()` from the panels; do not leave it as a fallback.
- The header line changes from "Live Telemetry (Simulated)" to the real thing, and that string
  becomes a test assertion.
- No UI copy claiming consciousness, feeling, or awareness. It is a memory system with dispositions;
  say that.

### 5.6 Performance

SSE coalesced to ≤ 30 frames/s of visual updates regardless of event rate; the stream pauses on
`document.hidden`; the client buffer is bounded; the server caps concurrent SSE clients (small — it
is localhost). Event volume is roughly one per tool call, which is nothing.

---

## 6. Can the self grow bigger and carry more weight?

Directly, since you asked: **yes, but not by getting longer.** Growth in tokens is the weakest
available axis, and past a point it is actively counterproductive.

**Why length is the wrong lever.** A 2 000-token self-description competes with itself — the model
skims a long undifferentiated block, and the ninth line about your dispositions dilutes the first.
Meanwhile the base model's persona is not a prompt you are out-numbering; it is in the weights. You
will never win that contest by volume, and every token you spend trying is a token of context the
user's actual task doesn't get. There is also a concrete cost argument: a stable self block is
prompt-cache-friendly, and a self block rewritten every turn busts the cache on every request.

**What actually carries weight.** Rank the channels by behavior-change per token:

| Channel | Token cost | Compliance |
|---|---|---|
| Inhibition thresholds derived from traits | 0 | Total — it is the gate |
| Sampling params from affect | 0 | Total |
| Recall bias — what it even notices | 0 | Total, and invisible |
| `tool.definition` notes at the point of decision | ~15/tool | Very high — inside the schema being reasoned over |
| Identity prose in the system prompt | 150–400 | Moderate, decaying with length |

The self gets *heavier* by moving down that table, not by expanding the last row. A trait vector that
shifts a block threshold changes behavior 100% of the time and costs zero tokens; a paragraph saying
"I am cautious" changes behavior sometimes. **The self should grow in dimensions, not in tokens.**

**That said, the prose tier should grow — in structure, and modestly in size.** The proposal:

```
Tier 1 · Core          ~200 tok   stable for weeks; top self_model rows by weight;
                                  cache-friendly; changes only when a disposition
                                  crosses an evidence threshold
Tier 2 · Situational   ~150 tok   rebuilt per task; domain affect + the lessons that
                                  bear on what is happening right now
Tier 3 · On demand     unbounded  a native `self_query` tool — the agent asks
                                  "what do I know about how I handle X?" and pays
                                  the tokens only when it matters
```

That is ~350 tokens resident versus 150 today, with unbounded depth available on request. Tier 3 is
the real answer to "bigger": depth moves out of the resident prompt and behind a tool call, which is
exactly how human self-knowledge works — you do not hold your entire autobiography in working memory,
you retrieve the relevant part.

**Growth must be earned, and the cap must bite.** A line enters Tier 1 only with ≥ N supporting
episodes above a weight floor, and the tier is hard-capped. When the cap is full, a new disposition
must *displace* an existing one on weight. That competition is what keeps the self sharp instead of
sprawling, and it makes growth meaningful: at any moment Tier 1 is the N things most true about this
agent, not the N things it happened to record.

**The honest ceiling.** Even with all of it, the model's chain-of-thought stays opaque — §1 of the
Phase 0–7 doc is still the governing constraint. What you get is a nervous system wrapped around a
rented cortex: a self that is real in the functional sense (behavior genuinely diverges by history,
is not resettable except by deleting memories, and is different for every user) without there being
continuous inner life between turns. Phase 13 narrows that gap and does not close it — scheduled
reflection is not spontaneity, and the plan should not pretend otherwise.

---

## 7. What this plan deliberately does not build

Listed because each one is tempting, and each would make the system worse:

- **`permission.ask` automation.** Flagged as a security surface in the Phase 0–7 doc; the assessment
  was right. Auto-allow can only ever widen what the user's config denies. Not "default off" — not
  built.
- **Emotional voice.** Affect modulates thresholds, never tone. An agent that performs moodiness is
  theater and is measurably less useful.
- **Unbidden action.** Reflection may think, write memories, and raise questions. It may not call a
  tool, edit a file, or touch the network.
- **Personality presets.** A "cautious / bold" config knob defeats the entire premise. Traits are
  earned or they are nothing.
- **LLM calls on any path that can block**, and LLM synthesis as a default anywhere.
- **Per-turn trait updates.** α ≤ 0.02 evaluated once per session. Fast-adapting personality reads as
  instability, not responsiveness.
- **Unbounded identity growth**, for the reasons in §6.
- **Simulated fallback data in the UI.** No signal renders as no signal.

---

## 8. Config surface

All new keys default to current behavior, so upgrading is a no-op until opted in.

```jsonc
{
  "brain": {
    // Phase 8
    "events": true,                    // emit brain events (observation only)
    "eventRetention": 20000,

    // Phase 9
    "selfModel": true,
    "identityTokens": 350,             // Tier 1 + Tier 2 combined cap

    // Phase 10
    "traits": false,                   // drifting temperament
    "traitLearningRate": 0.02,

    // Phase 11
    "affect": false,                   // persistent per-domain valence

    // Phase 12
    "schemaSynthesis": "structural",   // "off" | "structural" | "llm"
    "beliefRevision": true,

    // Phase 13
    "reflection": false,
    "reflectIdleMinutes": 30,

    // Phase 14
    "metacognition": false
  }
}
```

---

## 9. Risks

- **Trait drift can run away.** A caution loop ends as an agent that blocks everything. Mitigated by
  the `[0.15, 0.85]` clamp, decay toward baseline, α ≤ 0.02, per-session evaluation, and
  `--reset-self`. Ship the reset before shipping the drift.
- **The self can become confabulation.** Self-episodes are templated from measured state, never
  interpreted — the same discipline `buildContent` already enforces. The moment a self-fact comes
  from an LLM's characterization rather than a counter, it is fiction with provenance.
- **Evaluation is the real bottleneck.** None of Phases 10–14 can be judged from a unit test. The
  honest instrument is an **agent twin**: two installs, same task stream, one with traits and affect
  frozen, compared on the existing metrics over weeks. Build the twin harness with Phase 10 or accept
  that everything after it is unfalsifiable.
- **Event volume in pathological sessions.** A runaway tool loop could flood the ring. Bounded ring +
  drop counter + retention cap means the failure mode is lost telemetry, never a stalled agent.
- **The UI can lie in a new way.** A stale event tape rendering as live telemetry is exactly the
  silent-degradation failure the Phase 0–7 doc warns about. The LIVE/STALE/DEMO badge is a
  requirement, not decoration.
- **Cross-project self-contamination.** A disposition learned in one repo may not hold in another.
  `self_model` rows respect the existing `scope` and cross-project promotion threshold; global
  self-facts should need more evidence than project-local ones.

---

## 10. Sequencing

```
8  Event spine ──┬─▶ 9  Self memory ──┬─▶ 10 Traits ──┬─▶ 14 Metacognition
                 │                    │               │
                 └─▶ 12 Abstraction ──┘   11 Affect ──┘
                          │
                          └─▶ 13 Reflection
```

Phase 8 blocks everything. Phases 9 and 12 are independent of each other and can proceed in parallel.
Phase 10 needs both 8 (honest metrics) and 9 (a place to record why traits moved). Phase 11 needs 9.
Phase 13 needs 12 (there is nothing worth reflecting on without real abstraction). Phase 14 needs 10
and honest metrics from 8.

**If only one phase ships: Phase 8.** It makes the existing brain observable, fixes a dead metric,
turns the best-looking page in the product from a simulation into an instrument, and is the
prerequisite for judging whether any of the rest of this is working.
