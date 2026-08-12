# Synthetic Brain — embedding realmemory into the agent's whole reasoning chain

**Status:** design blueprint (not yet implemented)
**Code state analyzed:** `claude/opencode-agent-synthetic-brain-e7nwm5` @ `2ea4ce5` (v0.4.0, post issue #22 brain-loop)
**Scope:** how the OpenCode plugin layer can go from "memory that gets injected" to "memory the agent
reasons *through*" — perception, working memory, inhibition, prediction error, consolidation.

---

## 1. What "embed into the entire reasoning chain" can honestly mean

The model's chain-of-thought is not interceptable. No OpenCode hook can read or rewrite the tokens the
LLM generates while it thinks. Any design that claims to sit "inside" the reasoning is selling
something that doesn't exist.

What *is* interceptable is every boundary the reasoning crosses. A single agent turn is not one
monolithic act of thought — it is a sequence of gated steps, and the plugin host exposes a hook at
almost every gate:

```
user text ──▶ [chat.message] ──▶ system prompt assembled ──▶ [experimental.chat.system.transform]
    ──▶ tool schemas assembled ──▶ [tool.definition]
    ──▶ sampling params chosen ──▶ [chat.params]
    ──▶ ══ LLM reasons (opaque) ══
    ──▶ tool call proposed ──▶ [tool.execute.before]   ◀── the only real behavioral gate
    ──▶ permission needed ──▶ [permission.ask]
    ──▶ tool runs ──▶ [tool.execute.after]
    ──▶ ══ LLM reasons again (opaque) ══   (loop back to tool.execute.before, N times)
    ──▶ turn ends ──▶ [event: session.idle]
    ──▶ context fills ──▶ [experimental.session.compacting] / [event: session.compacted]
```

A brain that owns *every one of those gates* controls the complete input and the complete output of
each reasoning step, and observes the result of every action. That is functionally what a human
brain does to its own cortex: it does not inspect its own neuron firings either — it controls what
enters attention, what actions are permitted to execute, and what gets encoded afterward.

So the honest framing, and the one this document builds to:

> **realmemory cannot be inside the reasoning. It can be the thing that decides what the reasoning
> starts from, what it is allowed to do, and what it becomes afterward — on every step, without the
> agent ever choosing to consult it.**

That is the synthetic brain. Everything below is the mechanism.

---

## 2. Current coverage: the plugin uses 4 of ~11 gates

`src/plugin.ts` registers five handlers today:

| Hook | Used? | What it does now |
|---|---|---|
| `event` (`session.created`, `session.idle`) | ✅ | Auto-recall on start; decay scheduling; `evaluateDelta`; opt-in LLM summarization |
| `chat.message` | ✅ (user only) | Classify intent, stage a recall block |
| `experimental.chat.system.transform` | ✅ | Deliver the staged recall block into `output.system` |
| `tool.execute.after` | ✅ (2 narrow cases) | `read` on config files → `codebase_fact`; `bash` errors → `lesson_learned` |
| `experimental.session.compacting` | ✅ | Detached decay + dedup + bloat metric |
| **`tool.execute.before`** | ❌ | — |
| **`permission.ask`** | ❌ | — |
| **`chat.params`** | ❌ | — |
| **`tool.definition`** | ❌ | — |
| **`tool` (native tool registration)** | ❌ | Memory tools exist only via the separate MCP server |
| **`event`: `message.part.updated`, `file.edited`, `session.compacted`, `permission.replied`** | ❌ | — |

Every unused row is a place where memory currently *cannot* affect behavior. Note the shape of the
gap: **all four writable gates that change what the agent does — rather than what it reads — are
unused.** Today realmemory is a passive context supplier. Everything in §4 follows from closing that.

There is a second structural gap. The plugin never perceives the agent's own output: the
`chat.message` assistant branch was verified not to fire in the installed host (issue #22 plan,
round-2), so the loop learns from user text and two tool patterns only. It is blind to what the agent
actually decided, said, or attempted. §4.1 routes assistant-side perception through the event bus and
the already-implemented `fetchSessionTranscript` instead.

---

## 3. The load-bearing constraint: two speeds

`INV-017` says every brain-loop hook is non-blocking — `void (async () => {…})().catch(…)`. That
invariant is what keeps a slow embedding call from stalling the tool loop, and it is correct for
everything built so far.

**It is also incompatible with the gates that matter most.** `tool.execute.before`, `permission.ask`,
`chat.params`, and `tool.definition` are *synchronous decisions by construction*: the host is waiting
on the return value to decide what happens next. A detached promise there is a no-op.

And they cannot simply be made blocking. `store.recall()` on the semantic path embeds the query and
cosine-scores every matching row in JS (`src/store.ts:802`, `recallSemantic`) — tens to hundreds of
milliseconds, on a path that fires before *every single tool call*. That would make the agent feel
broken.

The resolution is the one biology already uses: **two pathways, not one.**

| | Reflex path | Deliberative path |
|---|---|---|
| **Analog** | Spinal reflex / basal ganglia gate | Cortex |
| **Hooks** | `tool.execute.before`, `permission.ask`, `chat.params`, `tool.definition` | `event`, `chat.message`, `tool.execute.after`, compacting |
| **Budget** | **< 5 ms, synchronous, in-process** | Unbounded, detached |
| **Data source** | `ReflexCache` — a RAM structure built at session start | Full SQLite + embeddings |
| **May do** | Set/regex/prefix lookups, string compare | Recall, embed, write, relate, decay |
| **May never do** | Touch the DB. Await I/O. Call an LLM. | Block a hook return |

### 3.1 `ReflexCache` (new: `src/reflex.ts`)

Built once on `session.created` (detached — the first tool call may race it, and a cold reflex cache
simply means no inhibition for that call, which is the safe failure mode). Refreshed on
`session.compacted` and after any high-salience write.

```ts
interface ReflexRule {
  memoryId: string;
  match: RegExp | ((call: ToolCall) => boolean);
  action: "warn" | "rewrite" | "block";
  rewrite?: (args: Record<string, unknown>) => Record<string, unknown>;
  note: string;        // shown to the model when it fires
  salience: number;    // 0..1 — drives ordering and the block threshold
  confidence: number;
}

interface ReflexCache {
  rules: ReflexRule[];          // hard cap ~100, sorted by salience × confidence
  preferences: string[];        // top global user_preference contents (identity block)
  arousal: number;              // 0..1 — recent correction/failure density
  builtAt: number;
}
```

Population: one `store.search()` at session start for `lesson_learned` + `user_preference` memories
above a weight floor, compiled into rules. Compilation is deliberately dumb — literal command
substrings, file-path globs, tool-name matches derived from `metadata.command` / `metadata.filePath`
that the existing auto-capture path already records. **No LLM, no embedding, no inference at reflex
time.** A rule that cannot be compiled to a cheap matcher is simply not a reflex; it stays a recall
candidate for the deliberative path.

This is the single most important structural decision in the design. Everything in §4.3 and §4.4
depends on it, and `INV-017` should be amended rather than violated:

> **INV-017 (amended):** deliberative-path hooks are detached and unbounded. Reflex-path hooks are
> synchronous, must complete within 5 ms, and may only read `ReflexCache`. No hook may await I/O on
> the reflex path.

---

## 4. The seven subsystems

### 4.1 Perception — see everything, not two tool patterns

*Hooks: `tool.execute.after`, `event: file.edited | message.part.updated | permission.replied`,
`session.idle` transcript fetch.*

Today's capture is two regex families: config-file reads and bash errors (`isConfigOrSchemaFile`,
`isErrorResult`). That is a keyhole. Widen perception to a uniform **percept stream** — one internal
event type, many sources:

```ts
interface Percept {
  kind: "tool_call" | "tool_result" | "user_turn" | "assistant_turn" | "file_edit" | "permission";
  tool?: string;
  args?: Record<string, unknown>;
  outcome?: "success" | "error";
  latencyMs?: number;
  text?: string;
  ts: number;
}
```

Percepts land in a bounded in-memory ring buffer (say 200) — the **sensory buffer**. Nothing is
written to SQLite at perception time. Writing is a *decision*, made later by §4.5 from prediction
error, not by a regex at the moment of seeing. This inverts today's model, and it is what stops the
store from bloating: the current design's only defense against noise is "capture almost nothing";
the new design can afford to see everything precisely because seeing is no longer storing.

Assistant-side perception, the blind spot: subscribe to `message.updated` / `message.part.updated` on
the `event` hook to capture assistant text and proposed tool calls as they stream, and keep
`fetchSessionTranscript` (`src/plugin.ts:154`) as the reconciliation pass on `session.idle`. Never
rely on the `chat.message` assistant branch — it does not fire.

### 4.2 Working memory — a managed budget, not a one-shot push

*Hook: `experimental.chat.system.transform`.*

Today: `state.pendingInjection` is a single formatted string, pushed once, then nulled; and
`injectedMemoryIds` guarantees a memory is *never* re-injected in a session. Both are wrong for a
brain.

- A memory injected at turn 3 and then evicted by compaction at turn 40 is *gone from the model's
  context* but still marked delivered. The agent has forgotten it and the brain refuses to remind it.
  Human working memory rehearses; this one has anterograde amnesia with a do-not-repeat rule.
- One flat block means no priority. Identity, the active task frame, and a one-off codebase fact all
  compete equally for attention.

Replace it with a **working-memory window** rebuilt every turn under an explicit token budget
(default ~800 tokens), assembled in fixed slots:

| Slot | Budget | Content | Refresh |
|---|---|---|---|
| Identity | ~150 tok | Top global `user_preference` by weight | Session start; sticky |
| Task frame | ~200 tok | Memories matching the current goal | On intent change |
| Active lessons | ~300 tok | High-salience `lesson_learned` for tools/files in play | Every turn |
| Open predictions | ~150 tok | Unresolved predictions from §4.5 | Every turn |

Eviction is by `salience × recency-of-use`, i.e. the same weighting the store already computes.
Rebuild the *whole* window each transform rather than appending deltas, so what the model sees is
always a coherent current state. Clear `injectedMemoryIds` on `session.compacted` — after compaction,
everything is fair game to re-inject, because the model genuinely no longer has it.

> **Delivery risk — verify, do not assume.** `experimental.chat.system.transform` and
> `experimental.session.compacting` are absent from `@opencode-ai/plugin`'s `Hooks` type, and OpenCode
> silently ignores unknown hook keys. There are third-party reports of `output.system` mutations
> being dropped downstream on some builds. This project has already been burned by exactly this class
> of bug once (Epic #3: `message.updated` was an event, not a hook, and never fired). See §6 — the
> whole design is gated on a probe that proves each hook fires *and lands*.

### 4.3 Inhibition — the gate that makes this a brain and not a notepad

*Hooks: `tool.execute.before`, `permission.ask`. Reflex path.*

This is the piece with no analog anywhere in the current codebase, and the reason the answer to the
question is "yes, but you have to add the gate."

Everything realmemory does today is advisory: it appends text and hopes the model reads it. A brain's
memory is not advisory. When you reach for a pan you were burned by, the retraction is not a
suggestion delivered to deliberation — it is a gate that fires before the action completes.

`tool.execute.before` receives `(input, output)` where `output.args` is mutable, and throwing aborts
the call with the error surfaced to the model. Three graded responses, chosen by rule salience:

- **`warn`** (salience < 0.5) — leave args alone; queue a one-line note into the next working-memory
  window. "You tried this before and it failed."
- **`rewrite`** (0.5–0.8, high confidence, deterministic fix) — mutate `output.args` in place.
  `npm install` → `npm ci` in a project where the last three `npm install` runs failed lockfile
  validation. The agent's action is corrected before it happens; it learns via §4.5 that the
  correction happened.
- **`block`** (≥ 0.8, `category: "safety" | "cost"`) — throw. The thrown message *is* the teaching
  signal: `"Blocked by realmemory: 2026-06-11 this command dropped the staging DB. Memory 01J… If
  this is intentional, say so and it will be recorded as an exception."` The model sees the block in
  its next reasoning step and routes around it. That is inhibition producing a behavior change inside
  a single turn.

`permission.ask` is the habit-formation counterpart: an action approved by the user N times in the
same shape becomes automatic (`allow`) — procedural memory, the thing that turns deliberate action
into habit; an action that preceded damage becomes `deny`. **Auto-`deny` must ship default-off and
auto-`allow` must never widen a permission the user's config denies** — a memory system that grants
itself permissions is a security bug, not a brain.

Guardrails, all non-negotiable: every rule traces to a memory ID the user can inspect in the graph
browser and `forget`; `block` requires explicit config opt-in (`inhibition: "off" | "warn" |
"rewrite" | "block"`, default `"warn"` for the first release); every fire is recorded as a metric so
false-positive rate is measurable; and a fired-and-then-overridden rule immediately loses confidence
(§4.5 treats the override as maximal prediction error).

### 4.4 Arousal and framing — modulate the reasoning, not just its inputs

*Hooks: `chat.params`, `tool.definition`. Reflex path.*

`chat.params` sets temperature / topP per request. `ReflexCache.arousal` — recent density of
corrections, failures, and blocks — maps to it directly: high arousal (the last few turns went badly)
→ lower temperature, tighten sampling, be careful; cold start on a novel task with no matching
memories → leave defaults or loosen slightly. This is a crude neuromodulator, and it should stay
crude: a small clamped delta (±0.15), never an override of an explicit user setting.

`tool.definition` is subtler and underrated. It rewrites the *tool schema the model reasons over*.
Instead of a memory sitting in a separate "here are some memories" block that the model may skim past,
the caveat lives inside the description of the tool it applies to:

> `bash` — Execute a shell command. **Project note (realmemory, 3 reinforcements): `npm install`
> fails lockfile validation here; use `npm ci`.**

The memory is no longer context the model must remember to consult. It is part of the definition of
the action, present at the exact moment of tool selection. Cap it hard — one or two lines per tool,
highest-weight rule only — or you inflate every request's prompt on every turn.

### 4.5 Prediction error — the actual learning rule

*Hooks: `tool.execute.before` (predict) → `tool.execute.after` (compare) → detached write.*

This is the mechanism that makes "learns like a human" true rather than decorative.

Today, storage is triggered by keyword heuristics: `classifyIntent` matches `/\bactually\b/`,
`isErrorResult` matches `/error:/i`. These fire on the *surface form* of text, so the store fills with
whatever happened to match a regex, and nothing distinguishes a lesson worth keeping from a routine
event that happened to contain the word "failed".

Human learning is not triggered by keywords. It is driven by **surprise** — the gap between what was
expected and what occurred (Rescorla–Wagner; the dopaminergic reward-prediction-error signal).
Outcomes that match expectation teach almost nothing. Outcomes that violate it drive nearly all
encoding. That principle maps onto this codebase's existing fields with almost no impedance:

```ts
// tool.execute.before — reflex path, cache lookup only, no I/O
const prediction = predictOutcome(call, reflexCache);   // { willSucceed: bool, confidence: 0..1 }
pendingPredictions.set(callID, prediction);

// tool.execute.after — detached
const actual = classifyOutcome(output);
const surprise = Math.abs(actual.success ? 1 : 0 - prediction.confidence);   // 0..1

if (surprise < 0.2) {
  // Expected. Cheap reinforcement of the supporting memories — no new row.
  await store.update(prediction.sourceMemoryId, { reinforce: true });
} else {
  // Surprising. Encode, with salience proportional to surprise.
  const m = await store.store({
    content: describe(call, actual),
    type: "lesson_learned",
    confidence: 0.4 + 0.4 * surprise,
    concise: true,
    metadata: { surprise, predicted: prediction, source: "prediction-error" },
  });
  await store.maybeRelate(m.id, m.content, m.type);
  if (surprise > 0.7) reflexCache.add(compileRule(m));   // strong lesson → immediate reflex
}
```

What this buys, concretely:

- **Storage volume becomes self-limiting.** The hundredth successful `npm test` produces no row —
  it is fully predicted. The first failure after ninety-nine successes produces a high-salience one.
  The store's growth rate tracks how much the world is surprising the agent, which is exactly the
  right currency. This is a strictly better answer to memory bloat than `concisenessCap` truncation.
- **Confidence stops being a magic number.** Today `confidence: 0.6` for corrections and `0.4` for
  bash errors are hand-picked constants. Under prediction error, confidence is *measured*: a memory
  that keeps predicting correctly climbs; one that mispredicts falls, and falls out of `ReflexCache`
  on its own.
- **User corrections become the strongest possible signal.** A user correction (`classifyIntent →
  "correction"`) is by definition maximal prediction error — the agent's model of what the user
  wanted was wrong. It should carry `surprise = 1.0` and encode at maximum salience. The existing
  `classifyIntent` is retained for exactly this: not as the storage trigger, but as one high-value
  percept source feeding the prediction-error engine.
- **Extinction comes free.** A rule whose prediction keeps failing decays below the reflex threshold
  and stops firing — without a separate "forget wrong lessons" subsystem.

### 4.6 Consolidation — episodes to rules, while "asleep"

*Hooks: `session.idle`, `experimental.session.compacting`, `session.compacted`.*

Existing idle work (LLM summarization, dedup, decay) is a good foundation but flat: it compresses
text. Real consolidation *changes representation* — the hippocampus replays episodes and the cortex
extracts the invariant across them. Two stages:

**Fast replay (`session.idle`, seconds).** Drain the sensory ring buffer, resolve any predictions still
open, write the surprising ones, run `maybeRelate`. Local heuristics only — no LLM, keeping Drift #5
closed.

**Slow consolidation (compaction, or a periodic pass, minutes-to-hours).** The valuable new step:
**schema formation.** When ≥ N (default 3) episodic memories cluster above the similarity threshold —
the machinery already exists in the `duplicateSimilarityThreshold` dedup path — synthesize one
abstract rule, link it `derived_from` each episode, then let the episodes decay normally. Three
memories about three different commands failing on missing `AWS_PROFILE` become one:
*"This project's AWS tooling requires AWS_PROFILE; it is not in the default env."*

That is the episodic→semantic transition, and it is what actually stops long-term bloat: the store
converges on rules whose count tracks the number of *distinct things true about the project*, not the
number of events. It also gives the graph browser something worth looking at — a hierarchy, rather
than a flat pile with dedup edges.

Scope promotion already implements a weak version of this (`crossProjectPromotionThreshold`);
schema formation is the same idea applied to abstraction level rather than scope.

### 4.7 Deliberate recall — give the agent a native memory tool

*Hook: `tool` registration.*

Everything above is involuntary — priming, not recall. Humans also query memory on purpose
("what was that thing about…"), and the agent should be able to as well, without the user having to
wire up the MCP server separately. Register three native tools in the plugin's return value:

- `memory_recall(query)` — deliberate search when the injected window wasn't enough.
- `memory_note(content, type)` — "remember this" as an explicit act.
- `memory_why(action)` — **introspection**: why did the brain block/rewrite/warn? Returns the
  memory IDs and their history. This is what makes the system debuggable instead of spooky, and it
  is the honest counterpart to §4.3's power. An agent that can be silently overruled by a rule it
  cannot inspect is a worse agent, not a better one.

---

## 5. Phasing

Each phase is independently shippable and independently valuable. Do not build past a phase whose
probe (§6) is red.

| Phase | Delivers | New/changed | Risk |
|---|---|---|---|
| **0. Hook probe** | Ground truth on which hooks fire and land | `src/hook-probe.ts`, metrics rows, `--doctor` | None — pure diagnostics. **Blocking prerequisite.** |
| **1. Reflex cache + inhibition (`warn`)** | `tool.execute.before` fires; notes surface; nothing blocked yet | `src/reflex.ts`, `plugin.ts` | Low — advisory only |
| **2. Prediction error** | Learning driven by surprise; storage volume self-limits | `src/predict.ts`, `tool.execute.*` | Medium — changes what gets stored |
| **3. Working-memory window** | Budgeted, slotted, rebuilt-per-turn injection | `src/working-memory.ts`, transform hook | Medium — depends on Phase 0 result |
| **4. `rewrite` + `permission.ask`** | Memory changes behavior, not just context | `plugin.ts`, config gate | **High — opt-in, default off** |
| **5. Arousal + `tool.definition`** | `chat.params` modulation; memory in tool schemas | `plugin.ts` | Low — clamped deltas |
| **6. Schema formation** | Episodes abstract into rules | `src/consolidate.ts` | Medium — needs eval |
| **7. Native memory tools** | Deliberate recall + `memory_why` | `plugin.ts` `tool:` | Low |

Config surface (all default to today's behavior, so an upgrade is a no-op until opted in):

```jsonc
{
  "brain": {
    "reflex": true,                 // build ReflexCache at session start
    "inhibition": "warn",           // "off" | "warn" | "rewrite" | "block"
    "predictionError": true,        // surprise-driven encoding
    "workingMemoryTokens": 800,
    "arousalModulation": false,     // chat.params deltas
    "toolDefinitionNotes": false,   // memory notes in tool schemas
    "schemaFormation": true,
    "autoPermission": false         // permission.ask automation — security-sensitive
  }
}
```

---

## 6. Phase 0 is not optional

OpenCode **silently discards hook keys it does not recognize**, and the two `experimental.*` hooks
this plugin's delivery path depends on are not in the published `Hooks` type. A plugin can therefore
be fully "working" — no errors, tests green, memories written — while injecting nothing into any
prompt. This repo has hit this exact failure once already.

`src/hook-probe.ts` must, on first session of each OpenCode version:

1. Record a `hook_fired` metric from inside *every* registered handler, with the version string.
2. For `experimental.chat.system.transform`, push a sentinel token into `output.system` and verify it
   **lands** — by reading it back from the session transcript via `client.messages()` on the next
   `session.idle`. Firing is not landing; the reported bug is specifically that mutations are dropped
   downstream.
3. Surface the results in `GET /api/metrics`, in the graph browser, and via a new
   `realmemory-mcp --doctor` command that prints a table of hook → fires / lands / last-seen.
4. Fall back automatically: if the transform hook does not land, degrade delivery to the paths known
   to work — a native tool the agent is instructed to call, plus `AGENTS.md`-adjacent instruction
   injection — and say so loudly in `--doctor`.

Silent degradation is the single worst failure mode for a memory system, because the agent behaves
exactly like an agent with no memory and nobody can tell why.

---

## 7. Honest risks

- **The inhibition gate can make the agent worse.** A false-positive `block` on a legitimate command
  wastes a turn and confuses the model. Mitigation: default `warn`, `block` requires opt-in plus
  salience ≥ 0.8 plus `category: safety|cost`; every override is maximal prediction error and drops
  the rule's confidence immediately.
- **Reflex-path latency is a hard budget.** 5 ms × every tool call. Any DB access on that path is a
  bug, not a slow spot. It needs an actual assertion in tests, not a comment.
- **`tool.definition` inflates every request.** One line per tool, top rule only, or it silently
  becomes a per-token tax on the whole session.
- **Prediction error changes what's stored.** Volume should drop and quality rise, but the honest
  test is A/B against the existing metrics (`recall_hit_rate`, `correction_retention`,
  `duplicate_rate`, `memory_bloat_ratio`) before making it the default.
- **Auto-permission is a security surface.** Auto-`allow` must never widen what the user's config
  denies. Default off, and it should probably stay off.
- **`experimental.*` hooks may vanish.** They are unversioned and untyped. Phase 0's probe plus the
  fallback path is the whole insurance policy.

---

## 8. The one-paragraph answer

Give the plugin a hook at every gate the reasoning crosses, and a job at each one. Perceive
everything cheaply into a sensory buffer rather than regex-capturing two things into SQLite
(`tool.execute.after`, event bus). Assemble a budgeted, slotted working-memory window fresh on every
turn instead of pushing one block once (`experimental.chat.system.transform`). Put a real inhibition
gate in front of every action, backed by an in-RAM reflex cache so it costs under five milliseconds
(`tool.execute.before`, `permission.ask`) — this is the step that converts memory from advice into
behavior. Modulate the reasoning's temperature and the tool schemas it reasons over
(`chat.params`, `tool.definition`). Learn from **prediction error** rather than keyword matches, so
the expected teaches nothing and the surprising teaches in proportion to how surprising it was.
Consolidate during idle and compaction, abstracting clustered episodes into rules and letting the
episodes decay. And prove every hook actually lands, because the host drops unknown hooks in silence.
The chain-of-thought stays opaque — but every input to it, every gate on it, and every consequence of
it is owned by the memory. That closed loop, running unbidden on every turn, is the synthetic brain.
