---
name: realmemory-bootstrap
description: Run a deep-learning phase to mine all available session history + project artifacts on the machine into a well-organized, weighted, interrelated realmemory database. Triggers on "bootstrap my memory", "deep learning phase", "mine my session history", "build my memory database", "consolidate my memory", "first session on this machine", "memory is thin", or when the agent notices its memory is sparse relative to how much work has happened on the box. Produces a compact history-catalog via a discovery script, then a cognitive pass (recall → store/update/relate/forget) that turns raw history into durable, weighted, web-linked memory.
version: 1.0.0
when_to_use: At the start of a session on a machine with substantial history but thin memory — when you realize you've chatted/worked a lot but your realmemory database doesn't reflect it. Also for periodic consolidation (quarterly) and onboarding a new agent to an existing workspace.
requires: realmemory installed (provides the 8 MCP tools: store_memory, recall, search, relate, update_memory, forget, list_memories, get_memory). Optional: opencode.db (OpenCode users) or any session-log source the discovery script supports.
---

# realmemory-bootstrap — deep learning phase

**Goal:** turn raw session history + project artifacts on the machine into a well-organized, weighted, interrelated memory database that compounds across sessions. After this pass, the next session starts with accumulated understanding, not a blank slate.

This skill is the cognitive half. It pairs with a **discovery script** (`scripts/discover-history.mjs`) that does the mechanical half: SQL + filesystem scan → a compact `history-catalog.json`. The script is dumb and fast; you (the agent) are smart and slow. **Never collapse them** — extracting transcripts in-agent burns context on exploration and you exit before doing the cognitive work (this is a documented failure mode). Run the script, read the compact catalog, then do the memory work via the realmemory MCP tools.

## The two tools

| Tool | What | When |
|------|-------|------|
| `scripts/bootstrap-memory.mjs` | **The primary tool.** A standalone Node script that autonomously processes ALL (or top-N) opencode sessions through an LLM to extract memories, deduplicates against the existing DB, and stores with embeddings. No agent in the loop. Scales to thousands of sessions. | First run on a new machine. Periodic re-ingestion. Any time you have 100+ sessions to process. |
| `scripts/discover-history.mjs` + agent | The manual fallback. The discovery script emits a catalog JSON; an agent follows the 7-phase cognitive pass below. Useful for targeted extraction (specific sessions, filesystem artifacts like ADRs/agent-defs that the automated script doesn't cover). | When the automated script doesn't cover a source. When you want agent-curated quality over volume. |

**Use the automated script first.** It processes sessions in parallel batches with configurable concurrency, handles LLM rate limits, deduplicates against existing memories via FTS5 keyword overlap, and stores directly to the realmemory SQLite DB. The agent-assisted flow is for the gaps the script can't fill (filesystem artifacts, cross-session pattern synthesis, relationship building).

## Automated bootstrap (the primary path)

```bash
# Auto-detect everything (LLM provider from opencode auth, DBs from default paths)
node scripts/bootstrap-memory.mjs

# Process only the top 50 sessions by cost
node scripts/bootstrap-memory.mjs --limit 50

# Process sessions >= $1, 5 in parallel
node scripts/bootstrap-memory.mjs --min-cost 1 --concurrency 5

# Dry run (extract + report, don't store)
node scripts/bootstrap-memory.mjs --dry-run

# Resume (skip already-processed sessions)
node scripts/bootstrap-memory.mjs --resume

# Override LLM provider
node scripts/bootstrap-memory.mjs --api-key sk-... --model gpt-4o-mini
node scripts/bootstrap-memory.mjs --model openrouter/auto  # uses openrouter key from auth.json
node scripts/bootstrap-memory.mjs --api-url http://localhost:8085/v1 --model local-model  # local LLM
```

**LLM provider auto-detection** (in order): CLI flags → realmemory.json config → opencode auth.json (openrouter → openai) → opencode.json local provider (llamacpp etc.)

**What the script does per session:**
1. Extracts the full transcript from opencode.db (truncated to 25k chars for LLM context)
2. Calls the LLM with an enhanced extraction prompt (asks for 5-15 memories with domain/category/weight/tags)
3. Defensively parses the JSON response
4. For each extracted memory: FTS5 keyword-search dedup against existing memories (skips if >60% word overlap)
5. Stores novel memories directly to the realmemory SQLite DB (with embeddings if @huggingface/transformers is available)
6. Tracks processed sessions for `--resume`

After the automated run, the agent can do a **refinement pass** (the 7 phases below) to:
- Mine filesystem artifacts the script doesn't cover (MEMORY.md, ADRs, agent definitions)
- Build relationships between memories (the script stores but doesn't relate)
- Classify domains more precisely
- Forget probe/stale memories

## The 7 phases

### Phase 1 — Discover

Run the script. From the realmemory repo (or any path with the script):

```bash
node scripts/discover-history.mjs --out /tmp/history-catalog.json --verbose
# optional: cap to recent / high-value sessions
node scripts/discover-history.mjs --out /tmp/history-catalog.json --min-cost 0.1 --limit 800
```

Read the catalog. The top-level shape:
- `dbSummary` — total sessions, messages, todos, cost, date range
- `sources` — every filesystem artifact found (MEMORY.md, PHASE_STATE.md per project, ADRs, agent defs, skills)
- `sessions` — ranked by cost desc, then todo count, then message count. Each row: id, title, directory, agent, model, cost, tokens, messageCount, todoCount, todos[], firstUserMessage, lastAssistantSnippet
- `nextSteps` — the same steps below, echoed in the catalog for self-containment

### Phase 2 — Inventory (the dedup baseline)

Before extracting anything, know what's already stored:

```
realmemory list_memories  (limit 100)
```

Note for each existing memory: id, type, domain, tags, weight. This is your dedup baseline. **A near-duplicate already in the store is not a new memory — it's an `update_memory(reinforce:true)` or a `relate(reinforces)`.** Re-storing duplicates pollutes the store and defeats recall.

### Phase 3 — Extract (prioritized — you can't process thousands of sessions)

You have finite context. The catalog ranks sessions for you. Process in this order (each source → candidate memories, not final storage yet):

**Tier 1 — condensed lessons (densest signal, lowest extraction cost):**
- **MEMORY.md** — every `### ` heading is a candidate `lesson_learned`. The `**Assumed:** / **Reality:** / **Lesson:** / **Reinforced:** / **Generalized:**` structure maps directly to realmemory's `metadata` (assumed/reality/lesson/learnedDate). This is the highest-yield source — process it exhaustively.
- **ADRs** — each is a `codebase_fact` (decision + rationale). Store the *why*, not just the what.
- **Agent definitions** (`~/.config/opencode/agent/*.md`, repo `.opencode/agents/*.md`) — `user_preference` memories: how the user wants agents to behave, what they value, what they reject.

**Tier 2 — high-signal sessions (real work happened):**
- Sort the catalog's `sessions` by `cost` desc, then `todoCount` desc. Take the top N that fit your budget (start with 20-40).
- For each: `node scripts/discover-history.mjs --session <id>` → full transcript.
- Extract: `user_preference` (corrections the user made), `lesson_learned` (things that broke and why), `codebase_fact` (non-obvious discoveries that took a stack trace / grep / doc dive), `task_pattern` (approaches that worked), `session_summary` (one per major session).

**Tier 3 — project state + patterns:**
- `PHASE_STATE.md` per project → `codebase_fact` (project status, resume points), `task_pattern` (how this project resumes).
- `PARKING_LOT.md` → `contextual_note` (deferred ideas — not work, just awareness).
- GitHub issues (if `gh` available) → `codebase_fact` (open gaps), `task_pattern` (closed epics).

**Content signals that flag a memory worth extracting:**
- "learned", "lesson", "gotcha", "broke", "fixed", "discovered", "turns out", "actually"
- The user said "remember this", "don't forget", "from now on", "always", "never"
- A correction: the agent did X, the user said "no, do Y" — that's a `user_preference`
- A dollar amount / time cost ("$850", "7 days") — that's a high-weight `lesson_learned`

### Phase 4 — Classify + weight (per candidate, BEFORE storing)

For each candidate, decide:

| Field | Guidance |
|-------|----------|
| `type` | `user_preference` (corrections, stated wants) · `task_pattern` (worked approaches, reproducible flows) · `codebase_fact` (non-obvious discoveries, decisions+rationale) · `lesson_learned` (hard-won: assumed/reality/lesson) · `session_summary` (what happened) · `contextual_note` (developing theories, half-formed insights, observations) |
| `domain` | The primary tech/topic: `aws`, `testing`, `opencode`, `anymake`, `terraform`, `vercel`, plus project names (`realhax`, `realvol`, `realcode`, `basecamp`, `realmemory`). Use `meta` for cognition-about-memory. |
| `category` | For lessons: `gotcha`, `cost`, `safety`, `process`, `tooling`, `integration`, `performance`. Other types may leave null. |
| `weight` | Pain that cost real $/time → high (0.9-0.97). Verified codebase fact → medium (0.6-0.8). User preference stated once → medium (0.5-0.7). Developing theory → low (0.3-0.5). The script's `cost` field is a proxy: a $5 session likely produced a high-weight lesson. |
| `confidence` | Verified by reproduction / multiple sessions → 0.95-0.97. Stated by user → 0.8-0.9. Inferred once → 0.5-0.6. A theory → 0.4-0.5. |
| `tags` | Retrieval hooks. Include the project, the tech, the failure-class (`orphan-resources`, `stacked-bugs`, `tracking`, `subagent-failure`). |
| `source` | `{ project, session, ref, refType }` — refType is `issue`/`pr`/`adr`/`file`/`commit`/`url`. Traceability matters: a memory with a source can be verified; one without can't. |
| `metadata` | For lessons: `{ assumed, reality, lesson, learnedDate }`. For codebase_facts: `{ location, evidence }`. Structured metadata is queryable; prose isn't. |
| `scope` | `project` (default) for project-specific. `global` for cross-project truths (AWS gotchas, opencode tool behavior, the user's general preferences). |

### Phase 5 — Relate (build the web — this is what makes memory compound)

After storing (or while storing), create typed relationships. Isolated memories don't compound; a web does. For each new/updated memory, ask:

- Does it **reinforce** an existing one? → `relate(reinforces)` (and consider `update_memory(reinforce:true)` to bump the target's confidence).
- Does it **contradict** an existing one? → `relate(contradicts)` AND surface it in the report. Don't silently overwrite — the contradiction is signal. The newer evidence usually wins, but the user may need to adjudicate.
- Does it **extend** an existing one (same theme, new surface)? → `relate(extends)`. This is the most common relationship — e.g., "AWS ASCII applies to create-image" → extends "AWS ASCII applies to CreateSecurityGroup" → generalize both to "every AWS API string param."
- Is it **derived_from** another? → `relate(derived_from)`.

Look for **clusters** (families of related memories): the AWS-ASCII family, the tracking-hygiene family, the sub-agent-context-exhaustion family, the orphan-resources family. A cluster with `extends`/`reinforces` edges is how you discover "I keep re-learning the same root cause on different surfaces" — which is itself a process bug worth storing.

### Phase 6 — Forget (retire the stale + the probes)

Use `forget` (archive by default; `hard:true` for genuine deletions) for:
- **Probe / test memories** — anything tagged `experience-check-probe`, `test`, `probe`. They're noise.
- **Stale memories contradicted by newer evidence** — if you stored "X works" and a later session proved "X is broken," the new one wins: store the new, forget the old (or relate(contradicts) + forget if the old is actively misleading).
- **Narrowly-written memories you've generalized** — if you rewrote "AWS rejects em-dashes in create-image" into "AWS rejects non-ASCII in every API string param," the narrow version is now noise: forget it (or `update_memory` the original to the generalized form — preferred over forget+re-store).

Forgetting is part of cognition — a memory that surfaces when it shouldn't is noise. But don't be trigger-happy: when in doubt, `relate(contradicts)` and let recall's weighting demote it, rather than hard-deleting.

### Phase 7 — Report

Surface to the user:

```
BOOTSTRAP COMPLETE
- Sessions scanned: N (of M total, top-K by cost)
- Sources processed: MEMORY.md (25 lessons), N ADRs, N agent defs, N PHASE_STATE files
- Memories: +A added, ~U updated (reinforce), ↔R related, ✗F forgotten
- Existing baseline: E memories before; E+A-F after
- Gaps: domains that are thin (e.g., "no realcode memories yet"), sources that yielded little
- Contradictions (need your eyes): list each new-vs-old conflict with both memory ids
- Next: a full exhaustive pass over the remaining (M-N) sessions would take ~X more runs; the script + this skill make it repeatable.
```

## Core rules (do not violate)

1. **Recall before EVERY store.** A near-duplicate is an update/reinforce, not a new store. Re-storing duplicates pollutes recall.
2. **The script does extraction; the agent does cognition.** Never read 89,000 messages into your context — read the compact catalog, dump transcripts one at a time via `--session <id>`.
3. **Weight reflects cost.** A lesson that burned $850 or 7 days is high-weight. A casual observation is low. The weighting is what makes recall surface the costly lessons first.
4. **Source everything.** A memory with a `source` (issue/adr/file/commit) can be verified; one without can't. Prefer traceable memories.
5. **Relate aggressively.** The web is the value. A store without a relate is half a memory.
6. **Forget probes + stale contradictions.** Noise compounds too; prune it.
7. **Generalize narrowly-written lessons.** When you re-hit a lesson on a new surface, rewrite the original to cover the whole surface (via `update_memory`), don't store a near-duplicate.
8. **Report honestly.** Including gaps and contradictions — those are the most actionable outputs for the user.

## What NOT to do

- Don't store trivial / obvious facts (every stored memory costs future context when recalled).
- Don't store a session_summary for every session — only the high-value ones (major work, hard-won lessons, turning points).
- Don't process sessions linearly by date — process by `cost` desc (the script sorts this way).
- Don't skip the recall-before-store step even when you're "sure" it's new — semantic recall catches near-duplicates your phrasing missed.
- Don't hardcode project-specific memories as `global` scope unless they truly generalize (AWS gotchas: global; realhax PHASE_STATE: project).
- Don't try to process all 1614 sessions in one run. The methodology is repeatable; do a high-value subset now, note the remainder for follow-up.

## Making it repeatable (for any realmemory user)

This skill + the discovery script ship with realmemory (in `skills/` and `scripts/`). A new user:
1. Installs realmemory (`npm i realmemory` or git install for the skill).
2. Runs `node scripts/discover-history.mjs --out catalog.json` (the script auto-detects opencode.db; for other hosts, extend the script's `loadSqlite`/`catalogSessions` to that host's schema).
3. Follows this skill's 7 phases.
4. Comes back next session with a well-organized, weighted memory database.

The script is host-aware (OpenCode today); to support another host (Claude Code, Cursor, etc.), add a branch to `catalogSessions` that queries that host's session store. The 7-phase cognitive pass is host-agnostic.
