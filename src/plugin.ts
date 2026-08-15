import { MemoryStore } from "./store";
import { loadConfig } from "./config";
import { deriveProjectId } from "./project-id";
import { classifyIntent, dynamicLimit, evaluateDelta } from "./brain-loop";
import type { Intent, ToolCapture } from "./brain-loop";
import {
  createProbeState,
  resetProbeForSession,
  resolveHostVersion,
  recordHookFired,
  recordLandsOutcome,
  pushSentinel,
  checkSentinelLanded,
  type ProbeState,
} from "./hook-probe";
import {
  buildReflexCache,
  matchCall,
  emptyReflexCache,
  addRule,
  compileRule,
  decideAction,
  decrementRuleConfidence,
  matchTool,
  computeArousal,
  emptyArousalTracker,
  pushArousalSignal,
  AROUSAL_TEMP_DELTA,
  AROUSAL_THRESHOLD,
  type ReflexCache,
  type ToolCall,
  type InhibitionLevel,
  type ArousalTracker,
  OVERRIDE_CONFIDENCE_DEC,
} from "./reflex";
import {
  predictOutcome,
  classifyOutcome,
  computeSurprise,
  shouldEncode,
  surpriseBin,
  describe,
  hashArgs,
  sortKeys,
  consumePrediction,
  type Prediction,
  type Outcome,
} from "./predict";
import {
  buildSummarizationPrompt,
  callSummaryProvider,
  parseSummarizationResponse,
} from "./summarize";
import type { MemoryStoreConfig, RecallResult, SummaryProviderConfig } from "./types";
import {
  assembleWorkingMemory,
  emptySlots,
  type WorkingMemorySlots,
} from "./working-memory";

/** Shape of the OpenCode plugin context object passed to the plugin entry point. */
export interface OpenCodePluginContext {
  project: { path?: string; name?: string } | unknown;
  client:
    | {
        app?: {
          log?: (args: {
            body: { service: string; level: string; message: string; extra?: unknown };
          }) => Promise<void>;
        };
      }
    | unknown;
  $: unknown;
  directory: string;
  worktree: string;
}

interface PluginState {
  store: MemoryStore | null;
  config: MemoryStoreConfig | null;
  injectedMemoryIds: Set<string>;
  /** Synthetic-brain Phase 3: working-memory slots staged by detached hooks.
   *  Replaces the old pendingInjection field. */
  workingMemory: WorkingMemorySlots;
  initialized: boolean;
  /** Shared in-flight init promise so concurrent detached hooks init once. */
  initPromise: Promise<MemoryStore> | null;
  lastUserText: string | null;
  lastUserIntent: Intent | null;
  recentUserTexts: string[];
  lastToolCapture: ToolCapture | null;
  lastInjectedMemoryIds: string[] | null;
  deltaTurnDone: boolean;
  /** Synthetic-brain Phase 0 probe state. */
  probe: ProbeState;
  sessionId: string | null;
  /** Synthetic-brain Phase 1: in-RAM reflex cache. Built at session.created (detached). */
  reflexCache: ReflexCache | null;
  /** Synthetic-brain Phase 1: warn note queued by tool.execute.before. Separate from
   *  pendingInjection to avoid the race where chat.message's detached recall
   *  overwrites pendingInjection (assignment) after tool.execute.before queued a note. */
  pendingWarnNote: string | null;
  /** Synthetic-brain Phase 2: pending predictions keyed by synthesized call ID.
   *  Set in tool.execute.before (reflex path), consumed+deleted in tool.execute.after
   *  (deliberative path). Swept on session.idle to prevent leaks. */
  pendingPredictions: Map<string, Prediction>;
  /** Monotonic counter for synthesizing call IDs (OpenCode provides none). */
  predictionCounter: number;
  /** Outcome of the most-recently-consumed prediction (same pattern as
   *  lastToolCapture). Consumed by the next turn's chat.message correction
   *  path — pendingPredictions is already empty by then because
   *  tool.execute.after consumes within the same turn. */
  lastPredictionOutcome: {
    prediction: Prediction;
    actual: Outcome;
    surprise: number;
    encodedMemoryId: string | null;
  } | null;
  /** Synthetic-brain Phase 4a: set when a `block` action fires. The next
   *  tool.execute.before checks whether the model retried the same call
   *  (override = exception). Cleared on a different call, on session.idle,
   *  or on override (consumed). Uses UNTRUNCATED argsKey (not hashArgs,
   *  which truncates at 200 chars — R1-C3). */
  lastBlock: {
    tool: string;
    argsKey: string;
    memoryId: string;
    confidence: number;
  } | null;
  /** Synthetic-brain Phase 5: rolling arousal signal tracker (last 5 turns). */
  arousalTracker: ArousalTracker;
}

/** Check if a file path looks like a config, schema, or route file worth capturing. */
export function isConfigOrSchemaFile(filePath: string): boolean {
  const patterns = [
    /package\.json$/,
    /tsconfig\.json$/,
    /\.env$/,
    /config\.(json|js|ts|yaml|yml)$/,
    /schema\.(ts|js|sql)$/,
    /routes?\.(ts|js)$/,
    /migration.*\.(ts|js|sql)$/,
    /Dockerfile$/,
    /docker-compose/,
  ];
  return patterns.some((p) => p.test(filePath));
}

/** Check if a bash result string looks like an error. */
export function isErrorResult(result: string): boolean {
  const errorPatterns = [
    /error:/i,
    /Error:/,
    /failed/i,
    /FAIL/,
    /cannot find/i,
    /permission denied/i,
    /not found/i,
    /exception/i,
    /traceback/i,
  ];
  return errorPatterns.some((p) => p.test(result));
}

/**
 * Synthetic-brain Phase 4a: build the block exception message.
 * The thrown message IS the teaching signal — names the memory, the consequence,
 * and tells the model how to override (retry = exception).
 */
export function blockMessage(rule: { note: string; memoryId: string }): string {
  return `Blocked by realmemory: ${rule.note} (memory ${rule.memoryId}). If this is intentional, retry the command and it will be recorded as an exception.`;
}

/**
 * Synthetic-brain Phase 4a: untruncated args key for override detection.
 * Uses sortKeys (exported from predict.ts) for deterministic key order, then
 * full JSON.stringify — NO truncation (hashArgs truncates at 200 chars, which
 * would cause false-positive overrides on long commands — R1-C3).
 */
function safeArgsKey(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(sortKeys(args));
  } catch {
    return "";
  }
}

/** Format recall results as a readable system message for injection. */
export function formatRecallResults(results: RecallResult[]): string {
  if (results.length === 0) return "";
  const lines = ["## Relevant memories from previous sessions", ""];
  results.forEach((r, i) => {
    const m = r.memory;
    lines.push(`${i + 1}. [${m.type}, weight: ${m.weight.toFixed(2)}] ${m.content}`);
    if (r.related.length > 0) {
      const relatedStr = r.related.map((rel) => `"${rel.content}"`).join("; ");
      lines.push(`   Related: ${relatedStr}`);
    }
  });
  return lines.join("\n");
}

/**
/**
 * Extract the user's typed text from a `chat.message` hook's `output.parts`
 * array. Text parts carry `type: "text"` and a `text` field; synthetic and
 * ignored parts are skipped so only the user's own input drives recall.
 */
export function extractUserText(parts: unknown[]): string {
  if (!Array.isArray(parts)) return "";
  return (parts as Array<{
    type?: string;
    text?: string;
    synthetic?: boolean;
    ignored?: boolean;
  }>)
    .filter(
      (p) =>
        p?.type === "text" &&
        typeof p?.text === "string" &&
        p.text.length > 0 &&
        p.synthetic !== true &&
        p.ignored !== true,
    )
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * Extract a plain-text representation from a message's `content` field. The
 * OpenCode SDK message content may be a plain string or an array of typed
 * parts (e.g. `{ type: "text", text: "..." }`); this defensively handles both
 * and returns "" when nothing usable is found.
 */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as { text?: unknown };
          if (typeof p.text === "string") return p.text;
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * Fetch a finished session's transcript through the OpenCode client, joined as
 * `"role: content"` lines. The client is loosely typed here, so any mismatch
 * (missing `messages` method, unexpected payload shape, or an error from the
 * client itself) results in `null` — the caller treats that as "skip".
 *
 * Returns `null` when the client is unavailable or the transcript is too thin
 * to summarize (< 3 messages or < 100 characters).
 */
async function fetchSessionTranscript(
  ctx: OpenCodePluginContext,
  sessionID: string,
): Promise<string | null> {
  const client = ctx.client as {
    messages?: (args: { params: { id: string } }) => Promise<unknown[]>;
  };
  if (typeof client?.messages !== "function") return null;

  let messages: unknown[];
  try {
    messages = await client.messages({ params: { id: sessionID } });
  } catch {
    return null;
  }
  if (!Array.isArray(messages)) return null;

  const lines: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as { role?: string; content?: unknown };
    const role = typeof m.role === "string" ? m.role : "unknown";
    const text = extractMessageText(m.content);
    if (text) lines.push(`${role}: ${text}`);
  }

  if (lines.length < 3) return null;
  const transcript = lines.join("\n");
  if (transcript.length < 100) return null;
  return transcript;
}

/**
 * OpenCode plugin entry point. Initializes a MemoryStore on first use (with
 * config loaded relative to `ctx.directory` and a project ID derived from it),
 * then returns the hook handlers:
 *   - `event` — auto-recall on `session.created` (staged for injection),
 *     auto-summarize on `session.idle`
 *   - `tool.execute.after` — auto-capture learnings (file reads on config/schema
 *     files become `codebase_fact`s; bash errors become `lesson_learned`s);
 *     fire-and-forget so a slow write never blocks the tool loop
 *   - `chat.message` — auto-recall on user messages, formatted results staged
 *     for injection and deduplicated against memories already delivered this
 *     session; fire-and-forget
 *   - `experimental.chat.system.transform` — the delivery mechanism: appends
 *     the staged recall block to the agent's system prompt and clears it, so
 *     the LLM actually sees the recalled memories
 *
 * @returns the hook handler map OpenCode installs the plugin's handlers from.
 */
export default async function realmemoryPlugin(
  ctx: OpenCodePluginContext,
): Promise<Record<string, unknown>> {
  const state: PluginState = {
    store: null,
    // Load config eagerly (a synchronous file read — no DB touch) so hooks
    // can honor switches like `autoCapture: false` BEFORE any store init.
    config: {
      ...loadConfig(ctx.directory),
      projectId: deriveProjectId(ctx.directory),
    },
    injectedMemoryIds: new Set(),
    workingMemory: emptySlots(),
    initialized: false,
    initPromise: null,
    lastUserText: null,
    lastUserIntent: null,
    recentUserTexts: [],
    lastToolCapture: null,
    lastInjectedMemoryIds: null,
    deltaTurnDone: false,
    probe: createProbeState(),
    sessionId: null,
    reflexCache: emptyReflexCache(),
    pendingWarnNote: null,
    pendingPredictions: new Map(),
    predictionCounter: 0,
    lastPredictionOutcome: null,
    lastBlock: null,
    arousalTracker: emptyArousalTracker(),
  };

  // Resolve host version once at plugin init (Phase 0 probe).
  state.probe.hostVersion = resolveHostVersion(ctx as Parameters<typeof resolveHostVersion>[0]);

  /**
   * Lazily create and initialize the MemoryStore. Concurrent calls (e.g. two
   * detached hook promises firing at once) share a single in-flight init so the
   * store is only ever constructed and initialized once — no double-opens of the
   * SQLite file, no double migration runs. A failed init clears the shared
   * promise so a later call can retry.
   */
  async function getStore(): Promise<MemoryStore> {
    if (state.initialized) return state.store!;
    if (!state.initPromise) {
      state.initPromise = (async () => {
        const store = new MemoryStore(state.config as MemoryStoreConfig);
        await store.init();
        state.store = store;
        state.initialized = true;
        return store;
      })().catch((error) => {
        state.initPromise = null;
        throw error;
      });
    }
    return state.initPromise;
  }

  async function log(level: string, message: string, extra?: unknown): Promise<void> {
    try {
      const client = ctx.client as {
        app?: { log?: (args: unknown) => Promise<void> };
      };
      if (client?.app?.log) {
        await client.app.log({ body: { service: "realmemory", level, message, extra } });
      }
    } catch {
      // Logging must never break hook execution or produce unhandled rejections.
    }
  }

  /**
   * Phase 3: record per-slot working-memory metrics (detached, INV-017).
   * Not exported. Records `working_memory:<slot>` for each non-empty slot.
   */
  function recordWorkingMemoryMetrics(
    getStore: () => Promise<MemoryStore>,
    sessionId: string | null,
    slots: import("./working-memory").WorkingMemorySlots,
  ): void {
    void (async () => {
      try {
        const store = await getStore();
        const slotNames: Array<[string, { content: string }]> = [
          ["identity", slots.identity],
          ["taskFrame", slots.taskFrame],
          ["queriedLessons", slots.queriedLessons],
          ["freshLessons", slots.freshLessons],
          ["openPredictions", slots.openPredictions],
        ];
        for (const [name, slot] of slotNames) {
          if (slot.content.length > 0) {
            await store.recordMetric(`working_memory:${name}`, 1, sessionId ?? undefined);
          }
        }
      } catch {
        // Metric recording is fire-and-forget — never throw.
      }
    })();
  }

  return {
    // On session events: auto-recall (created) and auto-summarize (idle).
    event: async ({
      event,
    }: {
      event: { type: string; [key: string]: unknown };
    }) => {
      if (event.type === "session.created") {
        // Phase 0 probe: reset probe state + capture sessionId BEFORE any config gate.
        const sid = (event as { properties?: { sessionID?: string } })?.properties?.sessionID;
        if (sid) {
          resetProbeForSession(state.probe, sid);
          state.sessionId = sid;
        }
        // Phase 5: clear arousal tracker (fresh session).
        state.arousalTracker = emptyArousalTracker();
        recordHookFired(getStore, state.probe, "event:session.created");

        try {
          const store = await getStore();
          const queryText = `Project at ${ctx.directory}`;
          const results = await store.recall({
            query: queryText,
            scope: "all",
            limit:
              (state.config as { maxRecallResults?: number }).maxRecallResults || 5,
            threshold:
              (state.config as { recallThreshold?: number }).recallThreshold || 0.3,
            traverse: true,
          });
          // Mark these as delivered so we don't re-inject them later, and
          // stage them in the working-memory taskFrame slot.
          results.forEach((r) => state.injectedMemoryIds.add(r.memory.id));
          if (results.length > 0) {
            state.workingMemory.taskFrame = {
              content: formatRecallResults(results),
              memoryIds: results.map((r) => r.memory.id),
            };
            await log("info", `Auto-recalled ${results.length} memories for new session`);
          }

          // ----- Synthetic-brain Phase 3: stage identity slot (sticky) -----
          // Top global user_preference by weight. Set once at session start.
          // Gated on brain.workingMemory (defaults true).
          const brainConfigWM = state.config as { brain?: { workingMemory?: boolean } };
          if (brainConfigWM.brain?.workingMemory !== false) {
            try {
              const idResults = await store.search({
                scope: "global",
                types: ["user_preference"],
                sortBy: "weight",
                sortOrder: "desc",
                limit: 1,
              });
              if (idResults.memories.length > 0) {
                const m = idResults.memories[0];
                state.workingMemory.identity = {
                  content: m.content,
                  memoryIds: [m.id],
                };
              }
            } catch {
              // Identity query failure is non-fatal — the slot stays empty.
            }
          }
        } catch (error) {
          await log(
            "error",
            `Auto-recall failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // ----- Decay scheduling (fire-and-forget) -----
        // Kick off decay rate-limited to once per decayIntervalHours. Runs on
        // a detached promise so it never blocks session startup; any failure is
        // logged, never thrown out of the handler.
        void (async () => {
          const store = await getStore();
          const intervalHours =
            (state.config as { decayIntervalHours?: number }).decayIntervalHours ?? 24;
          const ran = await store.maybeDecay("decay:lastRun", intervalHours);
          if (ran) {
            await log("info", "Memory decay completed");
          }
        })().catch((error) =>
          log(
            "error",
            `Memory decay failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );

        // ----- Synthetic-brain Phase 1: build ReflexCache (detached) -----
        // Gated on brain.reflex (defaults true). Cold cache = no inhibition = safe.
        if ((state.config as { brain?: { reflex?: boolean } }).brain?.reflex !== false) {
          void (async () => {
            try {
              const store = await getStore();
              state.reflexCache = await buildReflexCache(store);
              await log("debug", `ReflexCache built: ${state.reflexCache.rules.length} rules`);
            } catch (error) {
              await log(
                "error",
                `ReflexCache build failed: ${error instanceof Error ? error.message : String(error)}`,
              );
              // Cold cache = no inhibition — safe failure mode.
            }
          })();
        }
      }

      if (event.type === "session.idle") {
        // Phase 0 probe: record fire + check sentinel landing (detached, independent of autoSummarize).
        recordHookFired(getStore, state.probe, "event:session.idle");

        // Synthetic-brain Phase 5: capture arousal signals BEFORE the clearing
        // block below (R1-C1 fix — lastBlock and lastPredictionOutcome are
        // cleared at lines 534-536, so we must read them first).
        pushArousalSignal(state.arousalTracker, {
          correction: state.lastUserIntent === "correction",
          block: state.lastBlock !== null,
          highSurprise:
            state.lastPredictionOutcome !== null &&
            state.lastPredictionOutcome.surprise >= 0.5,
        });
        if (state.reflexCache) {
          state.reflexCache.arousal = computeArousal(state.arousalTracker);
        }

        // Synthetic-brain Phase 2: leak prevention. Pending predictions that
        // never got an `after` (e.g. tool was blocked, session ended mid-call)
        // are dropped rather than accumulated. The Map is bounded in practice
        // by the number of tool calls in a turn. lastPredictionOutcome is
        // also cleared — it's only meaningful within one turn of the outcome.
        // Phase 4a: clear lastBlock too (a block across sessions is stale).
        state.pendingPredictions.clear();
        state.lastPredictionOutcome = null;
        state.lastBlock = null;
        if (state.probe.sentinelToken && !state.probe.sentinelChecked) {
          const idleSid = (event as { properties?: { sessionID?: string } })?.properties?.sessionID;
          if (idleSid) {
            void (async () => {
              try {
                const store = await getStore();
                await checkSentinelLanded(
                  store,
                  state.probe,
                  () => fetchSessionTranscript(ctx, idleSid),
                );
              } catch {
                // Fire-safe.
              }
            })().catch(() => {});
          }
        }

        // C1 fix (PRIMARY trigger): per-turn delta evaluation on session.idle.
        // Runs BEFORE the LLM summarization. Detached (INV-017).
        if ((state.config as { brainLoop?: boolean }).brainLoop !== false) {
          // C1 fix: double-fire guard.
          if (state.deltaTurnDone) {
            state.deltaTurnDone = false;
          } else {
            void (async () => {
              const store = await getStore();
              await evaluateDelta(
                store,
                state as unknown as import("./brain-loop").BrainLoopState,
                state.lastUserText ?? "",
                "",
              );
              // C2 fix: clear lastToolCapture AFTER evaluateDelta completes.
              state.lastToolCapture = null;
            })().catch((error) =>
              log(
                "error",
                `evaluateDelta failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        }

        try {
          // Ensure config is loaded (getStore initializes state.config) before
          // deciding whether auto-summarization applies.
          await getStore();
          const config = state.config as {
            autoSummarize?: boolean;
            summaryProvider?: SummaryProviderConfig;
          };
          if (!config.autoSummarize || !config.summaryProvider) {
            await log("info", "Session idle — summarization skipped (no provider configured)");
            return;
          }
          const sessionID = (event as { properties?: { sessionID?: string } })
            .properties?.sessionID;
          if (!sessionID) {
            await log("info", "Session idle — summarization skipped (no session id)");
            return;
          }

          // ----- Detached reflective summarization (fire-and-forget) -----
          // The LLM call can take seconds; it must never block this handler
          // or a subsequent session.created. All work runs on a detached
          // promise and any failure is logged, never thrown out of the hook.
          void (async () => {
            try {
              const store = await getStore();
              const provider = config.summaryProvider!;
              const transcript = await fetchSessionTranscript(ctx, sessionID);
              if (!transcript) {
                await log(
                  "info",
                  "Session idle — summarization skipped (no substantive transcript)",
                );
                return;
              }
              const response = await callSummaryProvider(
                provider,
                buildSummarizationPrompt(transcript),
              );
              const memories = parseSummarizationResponse(response);
              if (memories.length === 0) {
                await log("info", "Session idle — LLM returned no parseable memories");
                return;
              }
              for (const m of memories) {
                await store.store({
                  content: m.content,
                  type: m.type,
                  scope: "project",
                  confidence: m.confidence,
                  tags: [...m.tags, "auto-summarized"],
                });
              }
              await log(
                "info",
                `Session idle — stored ${memories.length} auto-summarized memories`,
              );
            } catch (error) {
              await log(
                "error",
                `Session summarize failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          })();
        } catch (error) {
          await log(
            "error",
            `Session summarize failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },

    // Synthetic-brain Phase 1: reflex-path inhibition (warn only).
    // SYNCHRONOUS — must complete within 5ms. Cache-only, no I/O (ADR-010).
    // On match: queues a warn note into pendingWarnNote (separate from
    // pendingInjection to avoid the race where chat.message's detached recall
    // overwrites pendingInjection). The transform hook delivers both.
    //
    // Synthetic-brain Phase 2: predict + stash. Runs for BOTH match and
    // no-match calls (the uncertain default is the issue's headline behavior).
    // Gated ONLY on brain.predictionError !== false, independent of the
    // reflex/inhibition gates — a user who turns off warn notes still gets
    // prediction-error learning.
    //
    // Synthetic-brain Phase 4a: rewrite + block. The inhibition ceiling
    // (brain.inhibition) controls the max action: "warn" (default, Phase 1
    // behavior), "rewrite" (mutate output.args), "block" (throw + set
    // lastBlock for override detection). Override = same call retried →
    // confidence decrement (in-RAM + DB) → extinction.
    "tool.execute.before": (
      input: { tool: string; args?: Record<string, unknown> },
      output: { args?: Record<string, unknown> },
    ) => {
      // Phase 0 probe: record fire.
      recordHookFired(getStore, state.probe, "tool.execute.before");

      const brainConfig = state.config as {
        brain?: {
          reflex?: boolean;
          inhibition?: string;
          predictionError?: boolean;
        };
      };

      const inhibition: InhibitionLevel =
        (brainConfig.brain?.inhibition as InhibitionLevel) ?? "warn";

      // ----- Phase 4a: Override detection (R1-C1, R1-C3) -----
      // Check if the model retried the same call that was just blocked.
      // Uses UNTRUNCATED argsKey (R1-C3) — hashArgs truncates at 200 chars.
      const currentArgs = input.args ?? output.args ?? {};
      const currentArgsKey = safeArgsKey(currentArgs);

      if (state.lastBlock && state.lastBlock.tool === input.tool && state.lastBlock.argsKey === currentArgsKey) {
        // Override: the model retried the blocked call (the "exception").
        const blocked = state.lastBlock;
        state.lastBlock = null; // consume

        // Detached: metric + DB confidence decrement + in-RAM extinction (R1-C2 + R2-C1).
        const memId = blocked.memoryId;
        const newConfidence = Math.max(0, blocked.confidence - OVERRIDE_CONFIDENCE_DEC);
        if (state.reflexCache) {
          decrementRuleConfidence(state.reflexCache, memId, OVERRIDE_CONFIDENCE_DEC);
        }
        void (async () => {
          try {
            const store = await getStore();
            await store.recordMetric(`reflex_override:${memId}`, 1, state.sessionId ?? undefined);
            await store.update(memId, { confidence: newConfidence }).catch(() => {});
          } catch {
            // Fire-safe.
          }
        })();

        // Skip inhibition (decideAction NOT called). Still run predict+stash
        // (the retried call is real — tool.execute.after will classify it).
        // matchCall called ONLY to get the rule for prediction (R1-C1 step 6).
        if (brainConfig.brain?.predictionError !== false) {
          const cache = state.reflexCache;
          const rule = cache && cache.rules.length > 0
            ? matchCall(cache, { tool: input.tool, args: currentArgs })
            : null;
          const prediction = predictOutcome(rule);
          const callId = `${input.tool}:${hashArgs(currentArgs)}:${state.predictionCounter++}`;
          state.pendingPredictions.set(callId, prediction);
        }
        return; // call proceeds without inhibition
      }

      // Not an override — clear any stale lastBlock (a different call means
      // the model learned; the block is consumed).
      state.lastBlock = null;

      // ----- Normal inhibition path -----
      // C1: compute cache + rule WITHOUT the early returns that would make
      // predictOutcome(null) dead code. Cold cache → rule = null.
      const cache = state.reflexCache;
      const rule =
        cache && cache.rules.length > 0
          ? matchCall(cache, { tool: input.tool, args: input.args ?? output.args })
          : null;

      // Phase 4a: decide the action from config ceiling + rule capabilities.
      // brain.reflex !== false is implicitly preserved: reflex:false → cache
      // never built → rule=null → decideAction returns "none" (R1-N2).
      const action = decideAction(rule, inhibition);

      if (action === "block" && rule) {
        // Block: set lastBlock, record metric (detached BEFORE throw), then throw.
        state.lastBlock = {
          tool: input.tool,
          argsKey: currentArgsKey,
          memoryId: rule.memoryId,
          confidence: rule.confidence,
        };
        void (async () => {
          try {
            const store = await getStore();
            await store.recordMetric(
              `reflex_block:${rule.memoryId}`,
              1,
              state.sessionId ?? undefined,
            );
          } catch {
            // Fire-safe.
          }
        })();
        // Phase 2: still stash a prediction for this call (the block may be
        // overridden; if so, the outcome is classified). This must happen
        // BEFORE the throw.
        if (brainConfig.brain?.predictionError !== false) {
          const prediction = predictOutcome(rule);
          const callId = `${input.tool}:${hashArgs(currentArgs)}:${state.predictionCounter++}`;
          state.pendingPredictions.set(callId, prediction);
        }
        throw new Error(blockMessage(rule));
      }

      if (action === "rewrite" && rule?.rewrite) {
        // Rewrite: mutate output.args in place.
        const origArgs = output.args ?? input.args ?? {};
        const rewritten = rule.rewrite(origArgs);
        if (rewritten !== origArgs) {
          // The rewrite fn changed the args — apply the mutation.
          output.args = rewritten;
          void (async () => {
            try {
              const store = await getStore();
              await store.recordMetric(
                `reflex_rewrite:${rule.memoryId}`,
                1,
                state.sessionId ?? undefined,
              );
            } catch {
              // Fire-safe.
            }
          })();
          state.pendingWarnNote = `[realmemory reflex] Rewrote args: ${rule.note}`;
        } else {
          // Rewrite was a no-op (from not present — R1-N6). Fall back to warn.
          state.pendingWarnNote = `[realmemory reflex] ${rule.note}`;
          void (async () => {
            try {
              const store = await getStore();
              await store.recordMetric(
                `reflex_fire:${rule.memoryId}`,
                1,
                state.sessionId ?? undefined,
              );
            } catch {
              // Fire-safe.
            }
          })();
        }
      } else if (action === "warn" && rule) {
        // Warn: today's Phase 1 behavior (regression-free).
        state.pendingWarnNote = `[realmemory reflex] ${rule.note}`;
        void (async () => {
          try {
            const store = await getStore();
            await store.recordMetric(
              `reflex_fire:${rule.memoryId}`,
              1,
              state.sessionId ?? undefined,
            );
          } catch {
            // Fire-safe — never throw out of the reflex path.
          }
        })();
      }

      // Phase 2: predict + stash. Reflex path — cache-only, no I/O (ADR-010).
      // Gated ONLY on brain.predictionError !== false, so it runs for BOTH
      // match and no-match calls. Deliberately independent of the
      // reflex/inhibition gates. Runs AFTER inhibition actions (the prediction
      // is about the call as proposed — for rewrite, the ORIGINAL args, not
      // the corrected ones).
      if (brainConfig.brain?.predictionError !== false) {
        const prediction = predictOutcome(rule); // null-safe
        const callId = `${input.tool}:${hashArgs(input.args ?? output.args)}:${state.predictionCounter++}`;
        state.pendingPredictions.set(callId, prediction);
      }
    },

    // On tool execution: auto-capture learnings (if enabled, default true) +
    // synthetic-brain Phase 2: prediction error (surprise-driven encoding).
    // Non-blocking: the handler resolves immediately and all store work (DB
    // init + write) runs on a detached promise, so a slow write never blocks
    // the tool loop. Errors are logged, never thrown out of the handler.
    "tool.execute.after": (
      input: { tool: string; args?: Record<string, unknown> },
      output: { args?: Record<string, unknown>; output?: unknown },
    ) => {
      // Phase 0 probe: record fire before any config gate.
      recordHookFired(getStore, state.probe, "tool.execute.after");

      const captureConfig = state.config as { autoCapture?: boolean } | null;
      const brainConfig = state.config as {
        brain?: { predictionError?: boolean };
      };

      // C2: dual-gate early return. Only short-circuit the WHOLE handler when
      // BOTH the legacy auto-capture AND the prediction-error loop are
      // explicitly disabled. This preserves the fast no-op when both are off,
      // but ensures prediction-error runs even when autoCapture is false.
      if (
        captureConfig?.autoCapture === false &&
        brainConfig.brain?.predictionError === false
      )
        return;

      void (async () => {
        try {
          const store = await getStore();
          // Accept args from either position: the real OpenCode runtime passes
          // them on `input.args`; older callers/tests used `output.args`.
          const args = input?.args ?? output?.args ?? {};

          // ----- Legacy auto-capture (Phase 1 + Epic #3) -----
          // Gated on autoCapture !== false (its original behavior). Coexists
          // with the prediction-error block below — both may fire on the same
          // call (coexistence is explicit in the issue; a future phase may
          // retire the legacy paths once prediction error proves out).
          if (captureConfig?.autoCapture !== false) {
            // Read tool on config/schema/route files -> codebase_fact.
            if (input.tool === "read") {
              const filePath = (args as { filePath?: string })?.filePath || "";
              if (isConfigOrSchemaFile(filePath)) {
                const stored = await store.store({
                  content: `Read ${filePath}`,
                  type: "codebase_fact",
                  scope: "project",
                  confidence: 0.3,
                  tags: ["auto-captured", "file-read"],
                  metadata: { source: "tool.execute.after", tool: "read", filePath },
                });
                if ((state.config as { autoRelate?: boolean }).autoRelate !== false) {
                  void store.maybeRelate(stored.id, stored.content, stored.type).catch(() => {});
                }
                await log("debug", `Auto-captured codebase_fact for ${filePath}`);
                // Brain-loop capture: remember the tool outcome this turn so
                // classifyIntent can see it on the next user message.
                state.lastToolCapture = {
                  tool: input.tool,
                  filePath,
                  isError: isErrorResult(String(output?.output ?? "")),
                  timestamp: Date.now(),
                };
              }
            }

            // Bash tool on errors -> lesson_learned.
            if (input.tool === "bash") {
              const command = (args as { command?: string })?.command || "";
              const result = String(output?.output ?? "");
              if (isErrorResult(result)) {
                const stored = await store.store({
                  content: `Command failed: ${command.slice(0, 200)} → ${result.slice(0, 200)}`,
                  type: "lesson_learned",
                  scope: "project",
                  confidence: 0.4,
                  tags: ["auto-captured", "bash-error"],
                  metadata: {
                    source: "tool.execute.after",
                    tool: "bash",
                    command,
                    severity: "medium",
                  },
                });
                if ((state.config as { autoRelate?: boolean }).autoRelate !== false) {
                  void store.maybeRelate(stored.id, stored.content, stored.type).catch(() => {});
                }
                await log("debug", "Auto-captured lesson_learned from bash error");
                // Brain-loop capture: remember the tool outcome this turn so
                // classifyIntent can see it on the next user message.
                state.lastToolCapture = {
                  tool: input.tool,
                  command,
                  isError: isErrorResult(result),
                  timestamp: Date.now(),
                };
              }
            }
            // Write/Edit -> no capture (too noisy).
          }

          // ----- Synthetic-brain Phase 2: prediction error -----
          // Deliberative path (detached — INV-017). Gated on
          // brain.predictionError !== false, independent of autoCapture.
          if (brainConfig.brain?.predictionError !== false) {
            // C4: match the EXACT call via the full tool:argsHash: prefix.
            // tool.execute.after receives the same args as tool.execute.before,
            // so a full-prefix match disambiguates interleaved same-tool calls.
            // Fall back to most-recent-for-tool only when no hash matches.
            const callId = consumePrediction(
              state.pendingPredictions,
              input.tool,
              input.args ?? output?.args,
            );
            if (callId) {
              const prediction = state.pendingPredictions.get(callId)!;
              state.pendingPredictions.delete(callId);
              const actual = classifyOutcome(input.tool, output?.output, isErrorResult);
              const surprise = computeSurprise(prediction, actual);
              const bin = surpriseBin(surprise);
              await store.recordMetric(
                `prediction_error:${bin}`,
                1,
                state.sessionId ?? undefined,
              );

              let encodedMemoryId: string | null = null;
              if (shouldEncode(surprise)) {
                // Surprising: encode a new lesson_learned with salience
                // proportional to surprise (§4.5).
                const m = await store.store({
                  content: describe({ tool: input.tool, args }, actual),
                  type: "lesson_learned",
                  scope: "project",
                  confidence: 0.4 + 0.4 * surprise,
                  tags: ["prediction-error"],
                  metadata: {
                    surprise,
                    predicted: prediction,
                    source: "prediction-error",
                    tool: input.tool,
                    command: (args as { command?: string })?.command ?? null,
                    filePath: (args as { filePath?: string })?.filePath ?? null,
                  },
                });
                encodedMemoryId = m.id;
                if ((state.config as { autoRelate?: boolean }).autoRelate !== false) {
                  void store.maybeRelate(m.id, m.content, m.type).catch(() => {});
                }
                // Strong surprise → immediate reflex on the next call.
                if (surprise > 0.7 && state.reflexCache) {
                  const newRule = compileRule(m);
                  if (newRule) addRule(state.reflexCache, newRule);
                }
                await log("debug", `Prediction error: encoded lesson (surprise=${surprise.toFixed(2)}, bin=${bin})`);
              } else if (prediction.sourceMemoryId) {
                // Low surprise: cheaply reinforce the rule that produced the
                // prediction (INV-018 — explicit reinforcement, no new row).
                await store
                  .update(prediction.sourceMemoryId, { reinforce: true })
                  .catch(() => {});
              }

              // C3: record the outcome for the next turn's correction path.
              // Even when the after-hook already encoded (encodedMemoryId !=
              // null), the correction path reinforces THAT row rather than
              // storing a second one (double-encode avoidance).
              state.lastPredictionOutcome = {
                prediction,
                actual,
                surprise,
                encodedMemoryId,
              };

              // ----- Synthetic-brain Phase 3: stage freshLessons + openPredictions -----
              // C4 fix: freshLessons is a separate sub-slot (assignment, NOT prepend).
              // Same-turn overwrite is intended — two surprising outcomes in one turn
              // leave only the last. The earlier ones are encoded by Phase 2 and surface
              // via queriedLessons on later turns. Do NOT "fix" into an append.
              if (shouldEncode(surprise) && encodedMemoryId) {
                state.workingMemory.freshLessons = {
                  content: `- ${describe({ tool: input.tool, args }, actual)}`,
                  memoryIds: [encodedMemoryId],
                };
              }
              // C5 fix / 2-C1 fix: stage openPredictions for delivery on the NEXT
              // transform (consume-and-clear at the transform, NOT at chat.message).
              if (surprise >= 0.2) {
                state.workingMemory.openPredictions = {
                  content: `**Prediction error** (${input.tool}): expected ${actual.success ? "failure" : "success"}, observed ${actual.success ? "success" : "error"} (surprise=${surprise.toFixed(2)})`,
                  memoryIds: encodedMemoryId ? [encodedMemoryId] : [],
                };
              }
            }
          }
        } catch (error) {
          await log(
            "error",
            `Auto-capture/prediction failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
    },

    // On user message: recall memories matching the message text, format them,
    // and stage them for injection on the next `experimental.chat.system.transform`.
    // Non-blocking: recall runs on a detached promise; the handler resolves
    // immediately so a slow recall never delays message processing. Errors are
    // logged, never thrown out of the handler. Dedup is keyed on
    // `injectedMemoryIds`, so a memory delivered earlier (session start or a
    // previous message) is not staged a second time.
    "chat.message": (
      _input: { sessionID?: string },
      output: { message?: { role?: string }; parts?: unknown[] },
    ) => {
      // Phase 0 probe: record fire before any role check.
      recordHookFired(getStore, state.probe, "chat.message");

      if (output?.message?.role !== "user") return;
      const content = extractUserText(output?.parts ?? []);
      if (!content) return;

      // Reset per-turn injection state (new user message starts a new turn).
      // C2 fix: do NOT clear lastToolCapture here — it survives from the prior
      // turn's tool.execute.after through classifyIntent and evaluateDelta.
      state.lastInjectedMemoryIds = null;
      state.deltaTurnDone = false;

      // C4 fix: gate classification on brainLoop. When disabled, use fixed limit:3 (v0.3.0 behavior).
      const brainLoopEnabled = (state.config as { brainLoop?: boolean }).brainLoop !== false;
      let recallLimit = 3;
      let intent: import("./brain-loop").Intent = "generic";
      if (brainLoopEnabled) {
        intent = classifyIntent(content, "", state.recentUserTexts, state.lastToolCapture);
        state.lastUserText = content;
        state.lastUserIntent = intent;
        recallLimit = dynamicLimit(intent);
        // C4 fix: classify FIRST (check if in buffer), THEN push.
        state.recentUserTexts.push(content);
        if (state.recentUserTexts.length > 5) state.recentUserTexts.shift();
      }

      // ----- Synthetic-brain Phase 2: user correction via lastPredictionOutcome -----
      // A user correction is by definition maximal prediction error (§4.5) —
      // the agent's model of what the user wanted was wrong. Consume the last
      // tool-call's prediction outcome (set by tool.execute.after on the prior
      // turn) and force it to surprise=1.0. Coexists with evaluateDelta.
      const brainConfigPred = state.config as {
        brain?: { predictionError?: boolean };
      };
      if (
        intent === "correction" &&
        brainConfigPred.brain?.predictionError !== false &&
        state.lastPredictionOutcome
      ) {
        const outcome = state.lastPredictionOutcome;
        state.lastPredictionOutcome = null; // consume once
        void (async () => {
          try {
            const store = await getStore();
            if (outcome.encodedMemoryId) {
              // C3 double-encode avoidance: the after-hook already encoded
              // this event at surprise >= 0.2. The correction raises it to
              // max salience — reinforce + upgrade that row rather than
              // storing a second one (contents would differ only in the
              // surprise field; INV-018 dedup would NOT merge them).
              await store
                .update(outcome.encodedMemoryId, {
                  reinforce: true,
                  confidence: 0.8, // 0.4 + 0.4 * 1.0
                })
                .catch(() => {});
              await store.recordMetric(
                "prediction_error:high",
                1,
                state.sessionId ?? undefined,
              );
            } else {
              // After-hook did not encode (surprise < 0.2, or low-surprise
              // reinforce branch). Encode the max-salience lesson now.
              const m = await store.store({
                content: `User correction (max prediction error): ${content.slice(0, 200)}`,
                type: "lesson_learned",
                scope: "project",
                confidence: 0.8, // 0.4 + 0.4 * 1.0
                tags: ["prediction-error", "user-correction"],
                metadata: {
                  surprise: 1.0,
                  predicted: outcome.prediction,
                  actual: outcome.actual,
                  source: "prediction-error",
                  intent: "correction",
                },
              });
              void store.maybeRelate(m.id, m.content, m.type).catch(() => {});
              await store.recordMetric(
                "prediction_error:high",
                1,
                state.sessionId ?? undefined,
              );
              if (state.reflexCache) {
                const newRule = compileRule(m);
                if (newRule) addRule(state.reflexCache, newRule);
              }
            }
            await log("debug", "Prediction error: user correction encoded at max salience");
          } catch (error) {
            await log(
              "error",
              `Prediction-error correction failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })();
      }

      void (async () => {
        try {
          const store = await getStore();
          const config = state.config as {
            recallThreshold?: number;
            maxRecallResults?: number;
          };
          const results = await store.recall({
            query: content,
            scope: "all",
            limit: recallLimit,
            threshold: config.recallThreshold || 0.3,
            traverse: true,
          });

          // Deduplicate: skip memories already delivered this compaction window.
          const newResults = results.filter(
            (r) => !state.injectedMemoryIds.has(r.memory.id),
          );
          if (newResults.length > 0) {
            newResults.forEach((r) => state.injectedMemoryIds.add(r.memory.id));
            // Phase 3: stage into workingMemory.taskFrame (replaces pendingInjection).
            state.workingMemory.taskFrame = {
              content: formatRecallResults(newResults),
              memoryIds: newResults.map((r) => r.memory.id),
            };
            await log("info", `Auto-recalled ${newResults.length} memories for user message`);
          }

          // ----- Synthetic-brain Phase 3: stage queriedLessons (detached) -----
          // Top-N lesson_learned by weight. Gated on brain.workingMemory.
          // Tool-specific matching is the ReflexCache's job (Phase 1); the
          // working-memory window's active-lessons slot is broader salience-weighted context.
          const brainConfigWM = state.config as { brain?: { workingMemory?: boolean } };
          if (brainConfigWM.brain?.workingMemory !== false) {
            try {
              const lessonResults = await store.search({
                types: ["lesson_learned"],
                scope: "all",
                minWeight: 0.3,
                sortBy: "weight",
                sortOrder: "desc",
                limit: 5,
              });
              if (lessonResults.memories.length > 0) {
                const lessonTexts = lessonResults.memories.map((m) => `- ${m.content.slice(0, 200)}`);
                state.workingMemory.queriedLessons = {
                  content: lessonTexts.join("\n"),
                  memoryIds: lessonResults.memories.map((m) => m.id),
                };
              }
            } catch {
              // Lesson query failure is non-fatal — the slot stays empty.
            }
          }
        } catch (error) {
          await log(
            "error",
            `Message recall failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
    },

    // Delivery mechanism: OpenCode builds the LLM request (system prompt)
    // after a user message is received, so any recall block staged by
    // `session.created` or `chat.message` is appended to the system prompt
    // here. Phase 3: replaced the one-shot pendingInjection with a budgeted,
    // slotted working-memory window rebuilt every turn.
    "experimental.chat.system.transform": (
      _input: unknown,
      output: { system?: string[] },
    ) => {
      // Phase 0 probe — runs on EVERY transform fire, independent of
      // the working-memory window. Sentinel is pushed once per session.
      recordHookFired(getStore, state.probe, "experimental.chat.system.transform");
      const r = pushSentinel(state.probe, output);
      if (r.pushed && !r.assertionOk) {
        recordLandsOutcome(getStore, state.probe, 0);
      }

      if (!Array.isArray(output?.system)) {
        // Defensive: clear pendingWarnNote even on the not-an-array path
        // (C2 fix — matches the old plugin.ts defensive clear).
        state.pendingWarnNote = null;
        return;
      }

      const brainConfig = state.config as {
        brain?: { workingMemory?: boolean; workingMemoryTokens?: number };
      };

      if (brainConfig.brain?.workingMemory === false) {
        // Phase 3 disabled — deliver pendingWarnNote independently (C2 fix).
        // Warn-note delivery is gated by brain.inhibition, NOT brain.workingMemory.
        if (state.pendingWarnNote) {
          output.system.push(state.pendingWarnNote);
          state.pendingWarnNote = null;
        }
        return;
      }

      // Phase 3: assemble working-memory window
      const { formatted, deliveredMemoryIds } = assembleWorkingMemory(
        state.workingMemory,
        state.pendingWarnNote,
        { workingMemoryTokens: brainConfig.brain?.workingMemoryTokens },
      );

      if (formatted) {
        output.system.push(formatted);
        // C3 fix: set lastInjectedMemoryIds from taskFrame IDs ONLY (not the union
        // of all slots). Preserves recall_hit_rate semantics.
        // 2-C6 fix: the chat.message staging-time write of lastInjectedMemoryIds
        // is removed (single writer at delivery — the transform).
        state.lastInjectedMemoryIds = state.workingMemory.taskFrame.memoryIds.slice(-5);
        // Track delivered IDs for the compaction-scoped dedup.
        deliveredMemoryIds.forEach((id) => state.injectedMemoryIds.add(id));
        // 2-C5 fix: record per-slot metrics by passing the slots object.
        // Helper is detached (INV-017), lives in plugin.ts, not exported.
        recordWorkingMemoryMetrics(getStore, state.sessionId, state.workingMemory);
      }

      // 2-C1 fix: consume-and-clear openPredictions after assembly (delivery-then-
      // clear, mirroring pendingInjection). A surprise from turn N's tool loop is
      // delivered on turn N+1's transform and cleared here.
      state.workingMemory.openPredictions = { content: "", memoryIds: [] };

      // Clear pendingWarnNote (consumed by the window — C1 fix: only clear when
      // the window was assembled and the warn note was included in it. If formatted
      // is null AND warn note is non-null, the warn note wasn't delivered — don't clear.)
      if (formatted) {
        state.pendingWarnNote = null;
      }
    },

    // On context compaction: run detached hygiene (INV-017) — rate-limited
    // decay under a separate meta key (decay:compacting), a bounded dedup
    // pass, and a bloat-ratio snapshot. The hook resolves immediately; all
    // store work runs on a detached promise and any failure is logged, never
    // thrown out of the handler or the compaction flow.
    "experimental.session.compacting": () => {
      // Phase 0 probe: record fire.
      recordHookFired(getStore, state.probe, "experimental.session.compacting");

      // Phase 3: clear injectedMemoryIds (re-injectable after compaction) +
      // clear stale slots (force re-query on next chat.message). Keep identity (sticky).
      state.injectedMemoryIds.clear();
      state.workingMemory.taskFrame = { content: "", memoryIds: [] };
      state.workingMemory.queriedLessons = { content: "", memoryIds: [] };
      state.workingMemory.freshLessons = { content: "", memoryIds: [] };
      state.workingMemory.openPredictions = { content: "", memoryIds: [] };

      // Detached hygiene (INV-017). Runs on context compaction.
      void (async () => {
        try {
          const store = await getStore();
          const config = state.config as { compactingIntervalHours?: number };
          const intervalHours = config.compactingIntervalHours ?? 4;
          // Rate-limited decay check (separate from session.created's decay:lastRun).
          await store.maybeDecay("decay:compacting", intervalHours);
          // Always run dedupPass (it's bounded and idempotent).
          await store.dedupPass();
          // If maybeDecay didn't run (rate-limited), still record bloat ratio.
          await store.recordMetric("memory_bloat_ratio", await store.getBloatRatio());
        } catch (error) {
          await log(
            "error",
            `Compacting hygiene failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
    },

    // Synthetic-brain Phase 5: arousal-based temperature modulation.
    // Reflex path (ADR-010): synchronous, cache-only, <5ms. Reads
    // ReflexCache.arousal (in-RAM) and clamps temperature DOWN by up to 0.15.
    // Never increases temperature above the agent's setting. Default off
    // (brain.arousalModulation !== false gate).
    "chat.params": (
      _input: { sessionID?: string; agent?: string; model?: unknown; provider?: string },
      output: { temperature?: number; topP?: number; topK?: number; maxOutputTokens?: number },
    ) => {
      recordHookFired(getStore, state.probe, "chat.params");

      const brainConfig = state.config as {
        brain?: { arousalModulation?: boolean };
      };
      if (brainConfig.brain?.arousalModulation !== true) return;

      const cache = state.reflexCache;
      if (!cache || cache.arousal < AROUSAL_THRESHOLD) return;

      if (typeof output.temperature === "number" && output.temperature > 0) {
        const delta = cache.arousal * AROUSAL_TEMP_DELTA;
        const newTemp = Math.max(0, output.temperature - delta);
        output.temperature = newTemp;
        // Record metric (detached — INV-017).
        void (async () => {
          try {
            const store = await getStore();
            await store.recordMetric("arousal_modulation", delta, state.sessionId ?? undefined);
          } catch {
            // Fire-safe.
          }
        })();
      }
    },

    // Synthetic-brain Phase 5: memory notes in tool descriptions.
    // Reflex path (ADR-010): synchronous, cache-only, <5ms. Appends a one-line
    // note from the top reflex rule to the tool's description. Default off
    // (brain.toolDefinitionNotes !== false gate).
    "tool.definition": (
      input: { toolID?: string },
      output: { description?: string },
    ) => {
      recordHookFired(getStore, state.probe, "tool.definition");

      const brainConfig = state.config as {
        brain?: { toolDefinitionNotes?: boolean };
      };
      if (brainConfig.brain?.toolDefinitionNotes !== true) return;

      const toolID = input?.toolID;
      if (!toolID || typeof output.description !== "string") return;

      const cache = state.reflexCache;
      const rule = matchTool(cache, toolID);
      if (!rule) return;

      const noteText = rule.note.slice(0, 100);
      output.description = `${output.description} **Project note (realmemory): ${noteText}**`;

      void (async () => {
        try {
          const store = await getStore();
          await store.recordMetric(`tool_definition_note:${rule.memoryId}`, 1, state.sessionId ?? undefined);
        } catch {
          // Fire-safe.
        }
      })();
    },
  };
}
