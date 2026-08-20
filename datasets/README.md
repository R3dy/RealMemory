# Agentic Workflow LoRA Training Dataset

A comprehensive JSONL training dataset for LoRA fine-tuning that teaches models to execute agentic workflows 10x more effectively by combining the **Anymake build system** methodology with **RealMemory persistent memory** tools.

## What This Dataset Teaches

The dataset trains models on three interconnected capabilities:

### 1. Structured Agentic Thinking
- Phase-driven workflow execution (Foundation → Discovery → Planning → Solutioning → Implementation → Launch)
- Gate-driven progression with explicit approval checkpoints
- State persistence via durable artifacts (PHASE_STATE.md)
- Scope discipline — parking lot pattern for out-of-scope ideas

### 2. Persistent Memory Usage
- Proactive recall before starting any nontrivial task
- Strategic storage of preferences, facts, decisions, and lessons
- Reinforcement over duplication (update existing memories, don't re-store)
- Relationship graphs between connected memories
- Memory consolidation (episodic → semantic patterns)
- Memory maintenance and cleanup

### 3. Multi-Agent Orchestration
- Role separation (Orchestrator, Planner, Worker, Validator, Experience Runner)
- The cardinal anti-pattern: never collapse roles into one context
- Retry and escalation policies
- Experience-driven validation (actually running the built app)
- Security override handling

## Dataset Statistics

| Metric | Value |
|--------|-------|
| Total examples | 81 |
| Single-turn conversations | 77 |
| Multi-turn conversations | 4 |
| Estimated total tokens | ~100K |
| Average tokens per example | ~1,200 |

## Categories Covered

| # | Category | Examples | Description |
|---|----------|----------|-------------|
| 1 | Session Initialization | 5 | Starting/resuming projects with memory recall |
| 2 | Phase Execution | 8 | Executing each phase (0-5) with proper artifacts |
| 3 | RealMemory Tool Usage | 12 | All 12 MCP tools: store, recall, search, relate, update, forget, list, get, metrics, why, memory_recall, memory_note |
| 4 | Multi-Agent Orchestration | 8 | Dispatching agents, evaluating results, full pipeline cycles |
| 5 | State Management | 4 | PHASE_STATE.md, BOARD.md, artifact lifecycle |
| 6 | Gate Management | 3 | Phase transitions, autonomous mode, Product Owner Proxy |
| 7 | Escalation & Error Handling | 6 | Failure classification, retry policy, security escalation |
| 8 | Experience-Driven Validation | 3 | Running apps, comparing expected vs actual, failure diagnosis |
| 9 | Post-Launch Agile | 3 | Bug intake, solution architecture, traceability |
| 10 | Cognitive Patterns | 5 | Prediction error, reflex path, contradiction handling, consolidation |
| 11 | Cross-Cutting Patterns | 8 | Recommend don't list, scope enforcement, documents over memory, clean exits |
| 12 | Advanced Multi-Turn | 4 | Full workflow cycles, debugging with progressive memory, user corrections |
| 13 | Project Type Variations | 4 | SaaS, CLI, Library, Agentic Harness |
| 14 | Anti-Pattern Prevention | 3 | Orchestrator-as-worker, scope creep, assumption without escalation |

## Key Patterns in Each Example

Every training example demonstrates:

1. **`<thinking>` blocks** — Explicit reasoning about what phase the agent is in, what rules apply, what tools to use, and what the next step is
2. **Proactive memory use** — Recalling context before acting, storing lessons after learning
3. **Tool calls** — Proper selection and parameterization of RealMemory tools and other agent tools
4. **State updates** — Updating PHASE_STATE.md and BOARD.md after every action
5. **Clean communication** — Concrete recommendations, clear next steps, no option paralysis

## Format

Standard JSONL for instruction tuning (compatible with Axolotl, Unsloth, LLaMA-Factory, etc.):

```json
{
  "messages": [
    {"role": "system", "content": "You are an expert agentic workflow assistant..."},
    {"role": "user", "content": "Continue working on my project TaskFlow"},
    {"role": "assistant", "content": "<thinking>\nThe user wants to continue...\n</thinking>\n\nLet me pick up where we left off...\n\n[Tool Call: memory_recall]\nquery: \"TaskFlow project status\"\n..."}
  ]
}
```

Multi-turn examples include alternating user/assistant messages within a single JSONL entry.

## RealMemory Tools Reference

| Tool | When to Use | Key Parameters |
|------|-------------|----------------|
| `store_memory` | Learning a preference, fact, decision, or lesson | `content`, `type`, `tags`, `scope`, `confidence` |
| `recall` | Start of any task, suspecting past work is relevant | `query`, `scope`, `limit` |
| `search` | Need deterministic filtered results | `types`, `tags`, `scope`, `sortBy` |
| `relate` | Two memories are structurally connected | `sourceId`, `targetId`, `type` |
| `update_memory` | Re-confirming existing memory (reinforce, not duplicate) | `id`, `reinforce: true` |
| `forget` | Memory is wrong, stale, or superseded | `id`, `hard: false` (soft delete) |
| `list_memories` | Broad overview of what's stored | `scope`, `type`, `limit` |
| `get_memory` | Need full record of specific memory | `id` |
| `get_metrics` | Check memory system health | — |
| `memory_why` | Understanding why a tool call was blocked/warned | `limit` |
| `memory_recall` | Deliberate search for specific past context | `query`, `limit` |
| `memory_note` | Explicitly "remember this" for future sessions | `content`, `type`, `tags` |

## Memory Types

| Type | When to Store |
|------|---------------|
| `user_preference` | Durable preference stated by the user |
| `task_pattern` | Recurring pattern in how tasks are approached |
| `codebase_fact` | Structural fact about the codebase |
| `lesson_learned` | Something learned the hard way |
| `session_summary` | Summary of a session's work |
| `contextual_note` | Situational note that doesn't fit other categories |

## How to Use for LoRA Training

### With Unsloth

```python
from unsloth import FastLanguageModel
from datasets import load_dataset

dataset = load_dataset("json", data_files="agentic-workflow-lora-training.jsonl", split="train")

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="unsloth/Meta-Llama-3.1-8B-Instruct",
    max_seq_length=4096,
    load_in_4bit=True,
)

model = FastLanguageModel.get_peft_model(
    model,
    r=16,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    lora_alpha=16,
    lora_dropout=0,
    use_gradient_checkpointing="unsloth",
)
```

### With Axolotl

```yaml
base_model: meta-llama/Meta-Llama-3.1-8B-Instruct
datasets:
  - path: agentic-workflow-lora-training.jsonl
    type: chat_template
adapter: lora
lora_r: 16
lora_alpha: 16
sequence_len: 4096
```

## Sources

- **Anymake** — Phase-driven agentic build system (https://github.com/r3dy/anymake)
- **RealMemory** — Persistent memory MCP server with synthetic brain architecture (https://github.com/r3dy/realmemory)

## Generation

The dataset is generated by three Python scripts in this directory:
- `generate_lora_dataset.py` — Core examples (53)
- `generate_advanced_examples.py` — Advanced patterns (17)
- `generate_multiturn_examples.py` — Multi-turn conversations (11)

Run all three to regenerate: `python3 generate_lora_dataset.py && python3 generate_advanced_examples.py && python3 generate_multiturn_examples.py`
