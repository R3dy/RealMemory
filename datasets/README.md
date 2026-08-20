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
| Total examples | 364 |
| Single-turn conversations | 354 |
| Multi-turn conversations | 10 |
| Estimated total tokens | ~421K |
| Average tokens per example | ~1,158 |
| File size | ~1.7 MB |

## Categories Covered

### Core Dataset (81 examples)

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

### Comprehensive Expansion (71 examples)

| # | Category | Examples | Description |
|---|----------|----------|-------------|
| 15 | Meta Knowledge | 10 | What is Anymake, who created it, URL, installation, why it exists, comparison to other tools |
| 16 | Orchestrator Deep-Dive | 3 | Step 0 capability check, full orchestration loop, board maintenance |
| 17 | Planner Examples | 2 | Experience script authoring, BLOCKED brief handling |
| 18 | Validator & Experience Runner | 2 | Criterion classification, observe-never-fix cardinal rule |
| 19 | RealMemory Per-Tool (2 each) | 12 | Detailed examples of every MCP tool with realistic parameters |
| 20 | RealMemory Architecture | 3 | Reflex vs deliberative paths, weight formula, ONNX embeddings |
| 21 | Workflow Scenarios | 6 | End-to-end builds: SaaS, CLI, brownfield, API migration |
| 22 | Anti-Patterns & Corrections | 6 | Orchestrator-as-worker, skipping gates, assumption without recall |
| 23 | Session & State Management | 2 | PHASE_STATE.md lifecycle, session log entries |
| 24 | Multi-Turn Conversations | 4 | Progressive debugging, user corrections, phase transitions |
| 25 | Post-Launch & Agile | 2 | Bug intake with anymake-agile, sprint planning |
| 26 | Skill Invocation | 3 | anymake-build-loop, anymake-security-review, anymake-experience-check |
| 27 | Autonomous Mode | 2 | When to use, gate handling in autonomous mode |
| 28 | Advanced Memory Patterns | 2 | Memory consolidation, contradiction resolution |
| 29 | Gate Management Deep-Dive | 2 | Product Owner Proxy, autonomous gate progression |
| 30 | Brain Subsystems | 2 | Arousal signals, prediction error triggers |
| 31 | Experience Validation | 2 | Browser mode scripts, verdict decision tree |
| 32 | Project Type Workflows | 2 | Type-specific build orders and harness modes |
| 33 | Conventions & Patterns | 1 | CONVENTIONS.md usage and enforcement |
| 34 | Complete Session Flows | 2 | Full session lifecycle from startup to clean exit |

### Agent Deep-Dive Expansion (50 examples)

| # | Category | Examples | Description |
|---|----------|----------|-------------|
| 35 | Meta Knowledge Extended | 10 | System overview, installation, creator, problems solved, differentiators |
| 36 | Agent Deep Dives | 20 | 2 per agent across all 10 agents (role/restrictions + practical scenario) |
| 37 | Orchestration Patterns | 10 | Startup, BLOCKED briefs, failure types, security escalation, loop completion |
| 38 | Arbiter Policy | 10 | PR review rules, retry policies, intent conflicts, failure classification |

### Skills & Project Types Expansion (49 examples)

| # | Category | Examples | Description |
|---|----------|----------|-------------|
| 39 | Skill Deep Dives | ~22 | 2 per skill across all 11 skills (trigger + workflow) |
| 40 | Project Type Deep Dives | ~16 | 2 per project type across all 8 types (config + workflow) |
| 41 | Template Coverage | ~11 | Individual template generation and usage examples |

### Phases & Templates Expansion (43 examples)

| # | Category | Examples | Description |
|---|----------|----------|-------------|
| 47 | Phase Deep Dives | ~12 | 2 per phase (0-5) with detailed artifacts and gate criteria |
| 48 | Template Generation | ~25 | Individual template usage for key Anymake templates |
| 49 | Phase Transition Scenarios | ~6 | Gate progression, phase rollback, autonomous advancement |

### RealMemory Deep-Dive Expansion (70 examples)

| # | Category | Examples | Description |
|---|----------|----------|-------------|
| 42 | RealMemory Tool Mastery | ~24 | 2 per tool with detailed parameter usage and response handling |
| 43 | Memory Type Patterns | ~14 | 2 per memory type with proper scope/confidence/tags |
| 44 | Brain Architecture | ~14 | 2 per subsystem (perception, working memory, inhibition, arousal, prediction error, consolidation, deliberate recall) |
| 45 | Advanced Memory Workflows | ~8 | Contradiction resolution, consolidation, relationship graphs, memory maintenance |
| 46 | Multi-Turn Memory Scenarios | ~10 | Progressive recall, correction handling, session-spanning memory evolution |

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

The dataset is generated by multiple Python scripts in this directory:

| Script | Output | Examples |
|--------|--------|----------|
| `generate_lora_dataset.py` | `agentic-workflow-lora-training.jsonl` (base) | 53 |
| `generate_advanced_examples.py` | Appends to base | 17 |
| `generate_multiturn_examples.py` | Appends to base | 11 |
| `generate_comprehensive_expansion.py` | `comprehensive_expansion.jsonl` | 71 |

The `part1_agents_core.jsonl`, `part2_phases_templates.jsonl`, `part3_skills_types.jsonl`, and `part4_realmemory.jsonl` files contain agent deep-dives, phases/templates, skills/project types, and RealMemory-focused examples respectively.

All part files are merged into the final `agentic-workflow-lora-training.jsonl` (364 examples total).
