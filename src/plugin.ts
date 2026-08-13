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
  type ReflexCache,
  type ToolCall,
} from "./reflex";
import {
  predictOutcome,
  classifyOutcome,
  computeSurprise,
  shouldEncode,
  surpriseBin,
  describe,
  hashArgs,
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
  /** Formatted recall block staged for the next chat system prompt. */
  pendingInjection: string | null;
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
    pendingInjection: null,
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
          // stage the formatted block for the next system prompt.
          results.forEach((r) => state.injectedMemoryIds.add(r.memory.id));
          if (results.length > 0) {
            state.pendingInjection = formatRecallResults(results);
            await log("info", `Auto-recalled ${results.length} memories for new session`);
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
    "tool.execute.before": (
      input: { tool: string; args?: Record<string, unknown> },
      output: { args?: Record<string, unknown> },
    ) => {
      // Phase 0 probe: record fire.
      recordHookFired(getStore, state.probe, "tool.execute.before");

      // Config gate: brain.reflex defaults true; brain.inhibition defaults "warn".
      const brainConfig = state.config as {
        brain?: { reflex?: boolean; inhibition?: string };
      };
      if (brainConfig.brain?.reflex === false) return;
      if (brainConfig.brain?.inhibition === "off") return;

      // Reflex path: synchronous, cache-only, no I/O. Cold cache = no-op.
      const cache = state.reflexCache;
      if (!cache || cache.rules.length === 0) return;

      const call: ToolCall = { tool: input.tool, args: input.args ?? output.args };
      const rule = matchCall(cache, call);
      if (!rule) return;

      // Warn: queue a one-line note into pendingWarnNote (separate field — avoids race).
      state.pendingWarnNote = `[realmemory reflex] ${rule.note}`;

      // Record reflex_fire metric (detached — non-blocking, fire-and-forget).
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
    },

    // On tool execution: auto-capture learnings (if enabled, default true).
    // Non-blocking: the handler resolves immediately and all store work (DB
    // init + write) runs on a detached promise, so a slow write never blocks
    // the tool loop. Errors are logged, never thrown out of the handler.
    "tool.execute.after": (
      input: { tool: string; args?: Record<string, unknown> },
      output: { args?: Record<string, unknown>; output?: unknown },
    ) => {
      // Phase 0 probe: record fire before any config gate.
      recordHookFired(getStore, state.probe, "tool.execute.after");

      // Fast no-op: when auto-capture is disabled, return BEFORE any DB touch —
      // getStore() (and thus store init) never runs when disabled.
      const captureConfig = state.config as { autoCapture?: boolean } | null;
      if (captureConfig?.autoCapture === false) return;

      void (async () => {
        try {
          const store = await getStore();
          // Accept args from either position: the real OpenCode runtime passes
          // them on `input.args`; older callers/tests used `output.args`.
          const args = input?.args ?? output?.args ?? {};

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
        } catch (error) {
          await log(
            "error",
            `Auto-capture failed: ${error instanceof Error ? error.message : String(error)}`,
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
      if (brainLoopEnabled) {
        const intent = classifyIntent(content, "", state.recentUserTexts, state.lastToolCapture);
        state.lastUserText = content;
        state.lastUserIntent = intent;
        recallLimit = dynamicLimit(intent);
        // C4 fix: classify FIRST (check if in buffer), THEN push.
        state.recentUserTexts.push(content);
        if (state.recentUserTexts.length > 5) state.recentUserTexts.shift();
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

          // Deduplicate: skip memories already delivered this session.
          const newResults = results.filter(
            (r) => !state.injectedMemoryIds.has(r.memory.id),
          );
          if (newResults.length === 0) return;

          newResults.forEach((r) => state.injectedMemoryIds.add(r.memory.id));
          // C2 fix: track which IDs were delivered THIS TURN for the hit-rate metric.
          state.lastInjectedMemoryIds = newResults.map((r) => r.memory.id).slice(-5);
          state.pendingInjection = formatRecallResults(newResults);
          await log("info", `Auto-recalled ${newResults.length} memories for user message`);
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
    // here — and cleared so it is never injected twice.
    "experimental.chat.system.transform": (
      _input: unknown,
      output: { system?: string[] },
    ) => {
      // Phase 0 probe — runs on EVERY transform fire, independent of
      // pendingInjection. Sentinel is pushed once per session (guarded inside
      // pushSentinel). MUST be before the pendingInjection early return so
      // zero-recall sessions still produce a landing check.
      recordHookFired(getStore, state.probe, "experimental.chat.system.transform");
      const r = pushSentinel(state.probe, output);
      // pushSentinel is PURE: it does not touch the store. The handler records
      // the negative signal when the post-push assertion fails (the host handed
      // us a frozen/replace array that silently dropped the push).
      if (r.pushed && !r.assertionOk) {
        recordLandsOutcome(getStore, state.probe, 0);
      }

      // Phase 1: deliver both pendingInjection (recall block) and pendingWarnNote
      // (reflex warn). Two separate fields avoid the race where chat.message's
      // detached recall overwrites pendingInjection after tool.execute.before
      // queued a warn note.
      if (!state.pendingInjection && !state.pendingWarnNote) return;
      if (!Array.isArray(output?.system)) {
        // Defensive: OpenCode always sends `system: string[]`; if it does not,
        // drop the staged blocks rather than crashing the chat request.
        state.pendingInjection = null;
        state.pendingWarnNote = null;
        return;
      }
      if (state.pendingInjection) {
        output.system.push(state.pendingInjection);
        // C2 fix: stash the IDs delivered THIS TURN before clearing pendingInjection.
        state.lastInjectedMemoryIds = Array.from(state.injectedMemoryIds).slice(-5);
        state.pendingInjection = null;
      }
      if (state.pendingWarnNote) {
        output.system.push(state.pendingWarnNote);
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
  };
}
