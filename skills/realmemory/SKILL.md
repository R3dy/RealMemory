---
name: realmemory
description: Use realmemory's persistent memory when the agent or user needs to remember something across sessions, recall prior context, or store what was learned. Triggers on "remember this", "store a memory", "what did I say about", "recall context", "use realmemory", "agent memory", "persistent memory".
version: 1.0.0
when_to_use: At the start of any nontrivial task, whenever you learn a user preference, a non-obvious codebase fact, a decision with its rationale, or an approach that worked well — and whenever the user asks you to remember, store, or recall anything across sessions.
---

# realmemory — proactive memory use

realmemory is a persistent, weighted, searchable memory store that survives across sessions. Automatic hooks already recall relevant memories when a session starts or a user message arrives, and capture some tool results automatically. **This skill is a complement to those hooks, not a replacement** — it tells you when to use the MCP tools explicitly, so the high-value things you learn end up in memory even when no hook fires.

## When to recall (use `recall`)

Proactively call `recall`:

- **At the start of any nontrivial task** — before planning or writing code, query for prior context (`recall` with a natural-language query about the task). Defense-in-depth alongside the automatic session-start recall: catch context the hooks may have missed or that a different query surfaces.
- **When you suspect past work is relevant** — a user references something that happened "before", a config value looks familiar, an approach reminds you of an earlier session.
- **When deciding whether something is already known** — before storing a new memory, recall first (see below).

`recall` is semantic + keyword search returning ranked, related memories. For a deterministic filtered query (exact scope/type/tag/date/weight), use `search` instead.

## When to store (use `store_memory`)

Call `store_memory` when you notice any of these — the durable, non-obvious stuff worth keeping:

1. **A user correction or preference stated in conversation** — "actually, use tabs", "always run the formatter before committing", "I prefer X over Y".
2. **A non-obvious codebase fact you had to work to discover** — something that took a grep, a stack trace, or a doc dive to find. Not the obvious structure; the hard-won detail.
3. **A decision plus its rationale** — "we chose SQLite over Postgres because this is a single-user local tool" (store the *why*, not just the what).
4. **An approach that worked well** — a command sequence, a debugging path, a pattern that solved a problem. Not just failures.

Leave trivial or already-obvious facts alone — every stored memory costs future context when recalled. When in doubt, error toward capturing the ones on this list.

## Prefer reinforce over re-storing (no duplicates)

Before you call `store_memory`, check whether the memory already exists:

1. **`recall`** (or `search`) with a query matching what you're about to store.
2. If you find an existing memory that says the same thing:
   - **`update_memory` with `reinforce: true`** when you're re-confirming an existing memory's content — this bumps its confidence instead of creating a duplicate.
   - **`relate` with type `reinforces`** when one memory supports/re-confirms another, linking them structurally instead of duplicating.
3. Only call `store_memory` when no existing memory covers the point.

## Choosing `type`, `scope`, and `confidence`

Store each memory with a sensible `type` (this is how memories are categorized, indexed, and filtered):

| Type | Description | Example |
|------|-------------|---------|
| `user_preference` | A durable preference about how the user wants things done. | "The user prefers tabs over spaces." |
| `task_pattern` | A recurring pattern in how tasks are approached or structured. | "Bug reports are triaged by severity before assignment." |
| `codebase_fact` | A structural fact about the codebase. | "The API layer is in `src/api/`, backed by Postgres." |
| `lesson_learned` | Something learned the hard way — a failure and its fix. | "AWS `create-image` rejects non-ASCII characters in string params." |
| `session_summary` | A summary of what happened in a session. | "Set up staging; shipped stories 8.1–8.3; parked the metrics dashboard." |
| `contextual_note` | A situational note that doesn't fit the other categories. | "The deploy job is currently paused pending the secrets rotation." |

- **`scope`**: `project` for memories that only matter in the current project; `global` for preferences and lessons that apply to every project (the user's preferences are almost always `global`).
- **`confidence`**: `0.9` when the user stated it directly or you verified it; `0.5` (default) for things you inferred; lower for guesses. Confidence rises over time via `reinforce`, so you don't need to overshoot — state what the evidence supports now.
- Add **`tags`** with a few short keywords (e.g. `formatting`, `deploy`, `sqlite`) to make structured filtering easier later.

## Which tool, when — quick reference

| Situation | Tool |
|-----------|------|
| Task start — surface prior context | `recall` |
| Suspect past work is relevant | `recall` |
| Deterministic filtered query (scope/type/tag/weight/date) | `search` |
| Learned a preference/fact/decision/lesson that isn't stored | `store_memory` |
| Re-confirming an existing memory | `update_memory` with `reinforce: true` |
| Two memories are structurally connected (one supports/contradicts/extends another) | `relate` (type `reinforces`, `contradicts`, `extends`, `exception_to`, `derived_from`) |
| A memory is wrong, stale, or should no longer surface | `forget` |
| Broad overview of what's stored (pagination) | `list_memories` |
| Full record of one specific memory by ID | `get_memory` |

Remember: the hooks run whether or not you call these tools. This skill is how you make the *explicit, deliberate* memory decisions — the durable preferences, hard-won facts, decisions, and lessons worth keeping.