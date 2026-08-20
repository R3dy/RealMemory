# Twin Harness — Synthetic-Self Phase 10 Gate 2

The honest instrument for judging whether trait drift helps or hurts. Two
installs (frozen vs drifting) replayed against the same task stream, compared
on the four metrics:

- `recall_hit_rate`
- `duplicate_rate`
- `memory_bloat_ratio`
- `correction_retention`

## Run

```bash
# Default sample stream (5 sessions):
node scripts/twin/run-twin.mjs

# Custom stream + write result to file:
node scripts/twin/run-twin.mjs my-stream.json --out result.json
```

## Verdict

The verdict is `PASS` when the drifting install is not worse than the frozen
one on any of the four metrics (within a 0.01 tolerance). "Worse" is
metric-dependent:
- `recall_hit_rate`, `correction_retention`: higher is better
- `duplicate_rate`, `memory_bloat_ratio`: lower is better

A `FAIL` verdict means the trait drift is hurting — investigate which metric
degraded and why before promoting the drift to default-on.

## Task stream format

A JSON array of session objects:

```json
[
  {
    "operations": [
      { "kind": "store", "content": "...", "type": "lesson_learned", "domain": "aws", "tags": [], "confidence": 0.9 },
      { "kind": "recall", "query": "...", "limit": 3 },
      { "kind": "correction", "content": "..." }
    ],
    "corrections": 1,
    "recalls": 1
  }
]
```

Operation kinds:
- `store` — stores a memory (content, type, domain, tags, confidence)
- `recall` — runs a recall query (query, limit)
- `correction` — stores a user_preference correction

The `corrections` and `recalls` top-level fields drive trait observations in
the drifting install (caution rises with corrections, tenacity rises with
recalls).

## What this is NOT

This is a *smoke* instrument. The real evaluation runs over weeks of live use
with diverging task streams — two agents on two repos. This harness proves the
plumbing exists and the comparison is reproducible; it does not prove the
personality is "working" (that requires the two-week eval, §10 sequencing).
