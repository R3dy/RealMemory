import {
  checkSentinelLanded,
  createProbeState,
  pushSentinel,
  recordHookFired,
  recordLandsOutcome,
  resetProbeForSession,
  resolveHostVersion
} from "./chunk-RBTOZFHM.js";
import {
  classifyIntent,
  deriveProjectId,
  dynamicLimit,
  evaluateDelta
} from "./chunk-ZV65OZDS.js";
import {
  MemoryStore,
  loadConfig
} from "./chunk-2IP5VBRF.js";

// src/summarize.ts
var VALID_TYPES = /* @__PURE__ */ new Set([
  "user_preference",
  "task_pattern",
  "codebase_fact",
  "lesson_learned",
  "session_summary",
  "contextual_note"
]);
var DEFAULT_CONFIDENCE = 0.5;
var TYPE_DESCRIPTIONS = {
  user_preference: "anything the user stated about how they want things done.",
  task_pattern: "recurring approaches/conventions used or asked for.",
  codebase_fact: "structural facts discovered about the project.",
  lesson_learned: 'not just errors: includes "approach X worked well", "Y was a dead end", any hard-won insight.',
  session_summary: "one summary of what happened, always.",
  contextual_note: "anything situational worth keeping that doesn't fit above."
};
function buildSummarizationPrompt(transcript) {
  const typeLines = Object.keys(TYPE_DESCRIPTIONS).map((t) => `- ${t}: ${TYPE_DESCRIPTIONS[t]}`).join("\n");
  return [
    "You are an agent memory curator. Extract durable, reusable memories from",
    "the coding-session transcript below.",
    "",
    "Return ONLY a JSON array. Each element must be an object with exactly these fields:",
    '- "content": a non-empty, self-contained string describing the durable memory',
    "  (third person, past tense, no pronouns that need transcript context).",
    '- "type": exactly one of the six types below.',
    '- "confidence": a number from 0 to 1 (how sure you are this is worth keeping).',
    '- "tags": an array of short lowercase keyword strings (may be empty).',
    "",
    "The six memory types are:",
    typeLines,
    "",
    "Rules:",
    '- Always include exactly one entry with type "session_summary".',
    "- Do not invent facts \u2014 only extract what is actually present in the transcript.",
    "- Do not emit commentary, markdown, or prose outside the JSON array.",
    "",
    "Transcript:",
    '"""',
    transcript,
    '"""'
  ].join("\n");
}
function parseSummarizationResponse(response) {
  if (typeof response !== "string" || response.trim().length === 0) {
    return [];
  }
  const trimmed = response.trim();
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = null;
  }
  if (parsed === null || !Array.isArray(parsed)) {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence && fence[1]) {
      try {
        parsed = JSON.parse(fence[1].trim());
      } catch {
        parsed = null;
      }
    }
  }
  if (parsed === null || !Array.isArray(parsed)) {
    const first = trimmed.indexOf("[");
    const last = trimmed.lastIndexOf("]");
    if (first !== -1 && last > first) {
      try {
        parsed = JSON.parse(trimmed.slice(first, last + 1));
      } catch {
        parsed = null;
      }
    }
  }
  if (!Array.isArray(parsed)) return [];
  const result = [];
  for (const entry of parsed) {
    const memory = validateEntry(entry);
    if (memory) result.push(memory);
  }
  return result;
}
function validateEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry;
  if (typeof obj.content !== "string" || obj.content.trim().length === 0) {
    return null;
  }
  if (typeof obj.type !== "string" || !VALID_TYPES.has(obj.type)) {
    return null;
  }
  let confidence = typeof obj.confidence === "number" ? obj.confidence : DEFAULT_CONFIDENCE;
  if (!Number.isFinite(confidence)) confidence = DEFAULT_CONFIDENCE;
  confidence = Math.max(0, Math.min(1, confidence));
  const tags = Array.isArray(obj.tags) ? obj.tags.filter((t) => typeof t === "string") : [];
  return {
    content: obj.content.trim(),
    type: obj.type,
    confidence,
    tags
  };
}
async function callSummaryProvider(provider, prompt) {
  const model = provider.model;
  const apiKey = provider.apiKey;
  let url = provider.apiUrl;
  if (!url) {
    url = provider.provider === "anthropic" ? "https://api.anthropic.com/v1/messages" : "https://api.openai.com/v1/chat/completions";
  }
  const isAnthropic = provider.provider === "anthropic" || url.endsWith("/v1/messages");
  if (isAnthropic) {
    const headers2 = {
      "Content-Type": "application/json",
      ...apiKey ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : {}
    };
    const response2 = await fetch(url, {
      method: "POST",
      headers: headers2,
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!response2.ok) {
      throw new Error(
        `Summary provider error: ${response2.status} ${response2.statusText}`
      );
    }
    const data2 = await response2.json();
    const text2 = Array.isArray(data2?.content) ? data2.content.map((c) => c?.text ?? "").join("") : "";
    if (!text2) {
      throw new Error("Summary provider returned no text content");
    }
    return text2;
  }
  const headers = {
    "Content-Type": "application/json",
    ...apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  };
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }
    })
  });
  if (!response.ok) {
    throw new Error(
      `Summary provider error: ${response.status} ${response.statusText}`
    );
  }
  const data = await response.json();
  const text = typeof data?.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "";
  if (!text) {
    throw new Error("Summary provider returned no text content");
  }
  return text;
}

// src/plugin.ts
function isConfigOrSchemaFile(filePath) {
  const patterns = [
    /package\.json$/,
    /tsconfig\.json$/,
    /\.env$/,
    /config\.(json|js|ts|yaml|yml)$/,
    /schema\.(ts|js|sql)$/,
    /routes?\.(ts|js)$/,
    /migration.*\.(ts|js|sql)$/,
    /Dockerfile$/,
    /docker-compose/
  ];
  return patterns.some((p) => p.test(filePath));
}
function isErrorResult(result) {
  const errorPatterns = [
    /error:/i,
    /Error:/,
    /failed/i,
    /FAIL/,
    /cannot find/i,
    /permission denied/i,
    /not found/i,
    /exception/i,
    /traceback/i
  ];
  return errorPatterns.some((p) => p.test(result));
}
function formatRecallResults(results) {
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
function extractUserText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.filter(
    (p) => p?.type === "text" && typeof p?.text === "string" && p.text.length > 0 && p.synthetic !== true && p.ignored !== true
  ).map((p) => p.text).join("\n").trim();
}
function extractMessageText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const p = part;
        if (typeof p.text === "string") return p.text;
      }
      return "";
    }).join("\n").trim();
  }
  return "";
}
async function fetchSessionTranscript(ctx, sessionID) {
  const client = ctx.client;
  if (typeof client?.messages !== "function") return null;
  let messages;
  try {
    messages = await client.messages({ params: { id: sessionID } });
  } catch {
    return null;
  }
  if (!Array.isArray(messages)) return null;
  const lines = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg;
    const role = typeof m.role === "string" ? m.role : "unknown";
    const text = extractMessageText(m.content);
    if (text) lines.push(`${role}: ${text}`);
  }
  if (lines.length < 3) return null;
  const transcript = lines.join("\n");
  if (transcript.length < 100) return null;
  return transcript;
}
async function realmemoryPlugin(ctx) {
  const state = {
    store: null,
    // Load config eagerly (a synchronous file read — no DB touch) so hooks
    // can honor switches like `autoCapture: false` BEFORE any store init.
    config: {
      ...loadConfig(ctx.directory),
      projectId: deriveProjectId(ctx.directory)
    },
    injectedMemoryIds: /* @__PURE__ */ new Set(),
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
    sessionId: null
  };
  state.probe.hostVersion = resolveHostVersion(ctx);
  async function getStore() {
    if (state.initialized) return state.store;
    if (!state.initPromise) {
      state.initPromise = (async () => {
        const store = new MemoryStore(state.config);
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
  async function log(level, message, extra) {
    try {
      const client = ctx.client;
      if (client?.app?.log) {
        await client.app.log({ body: { service: "realmemory", level, message, extra } });
      }
    } catch {
    }
  }
  return {
    // On session events: auto-recall (created) and auto-summarize (idle).
    event: async ({
      event
    }) => {
      if (event.type === "session.created") {
        const sid = event?.properties?.sessionID;
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
            limit: state.config.maxRecallResults || 5,
            threshold: state.config.recallThreshold || 0.3,
            traverse: true
          });
          results.forEach((r) => state.injectedMemoryIds.add(r.memory.id));
          if (results.length > 0) {
            state.pendingInjection = formatRecallResults(results);
            await log("info", `Auto-recalled ${results.length} memories for new session`);
          }
        } catch (error) {
          await log(
            "error",
            `Auto-recall failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        void (async () => {
          const store = await getStore();
          const intervalHours = state.config.decayIntervalHours ?? 24;
          const ran = await store.maybeDecay("decay:lastRun", intervalHours);
          if (ran) {
            await log("info", "Memory decay completed");
          }
        })().catch(
          (error) => log(
            "error",
            `Memory decay failed: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
      if (event.type === "session.idle") {
        recordHookFired(getStore, state.probe, "event:session.idle");
        if (state.probe.sentinelToken && !state.probe.sentinelChecked) {
          const idleSid = event?.properties?.sessionID;
          if (idleSid) {
            void (async () => {
              try {
                const store = await getStore();
                await checkSentinelLanded(
                  store,
                  state.probe,
                  () => fetchSessionTranscript(ctx, idleSid)
                );
              } catch {
              }
            })().catch(() => {
            });
          }
        }
        if (state.config.brainLoop !== false) {
          if (state.deltaTurnDone) {
            state.deltaTurnDone = false;
          } else {
            void (async () => {
              const store = await getStore();
              await evaluateDelta(
                store,
                state,
                state.lastUserText ?? "",
                ""
              );
              state.lastToolCapture = null;
            })().catch(
              (error) => log(
                "error",
                `evaluateDelta failed: ${error instanceof Error ? error.message : String(error)}`
              )
            );
          }
        }
        try {
          await getStore();
          const config = state.config;
          if (!config.autoSummarize || !config.summaryProvider) {
            await log("info", "Session idle \u2014 summarization skipped (no provider configured)");
            return;
          }
          const sessionID = event.properties?.sessionID;
          if (!sessionID) {
            await log("info", "Session idle \u2014 summarization skipped (no session id)");
            return;
          }
          void (async () => {
            try {
              const store = await getStore();
              const provider = config.summaryProvider;
              const transcript = await fetchSessionTranscript(ctx, sessionID);
              if (!transcript) {
                await log(
                  "info",
                  "Session idle \u2014 summarization skipped (no substantive transcript)"
                );
                return;
              }
              const response = await callSummaryProvider(
                provider,
                buildSummarizationPrompt(transcript)
              );
              const memories = parseSummarizationResponse(response);
              if (memories.length === 0) {
                await log("info", "Session idle \u2014 LLM returned no parseable memories");
                return;
              }
              for (const m of memories) {
                await store.store({
                  content: m.content,
                  type: m.type,
                  scope: "project",
                  confidence: m.confidence,
                  tags: [...m.tags, "auto-summarized"]
                });
              }
              await log(
                "info",
                `Session idle \u2014 stored ${memories.length} auto-summarized memories`
              );
            } catch (error) {
              await log(
                "error",
                `Session summarize failed: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          })();
        } catch (error) {
          await log(
            "error",
            `Session summarize failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    },
    // On tool execution: auto-capture learnings (if enabled, default true).
    // Non-blocking: the handler resolves immediately and all store work (DB
    // init + write) runs on a detached promise, so a slow write never blocks
    // the tool loop. Errors are logged, never thrown out of the handler.
    "tool.execute.after": (input, output) => {
      recordHookFired(getStore, state.probe, "tool.execute.after");
      const captureConfig = state.config;
      if (captureConfig?.autoCapture === false) return;
      void (async () => {
        try {
          const store = await getStore();
          const args = input?.args ?? output?.args ?? {};
          if (input.tool === "read") {
            const filePath = args?.filePath || "";
            if (isConfigOrSchemaFile(filePath)) {
              const stored = await store.store({
                content: `Read ${filePath}`,
                type: "codebase_fact",
                scope: "project",
                confidence: 0.3,
                tags: ["auto-captured", "file-read"],
                metadata: { source: "tool.execute.after", tool: "read", filePath }
              });
              if (state.config.autoRelate !== false) {
                void store.maybeRelate(stored.id, stored.content, stored.type).catch(() => {
                });
              }
              await log("debug", `Auto-captured codebase_fact for ${filePath}`);
              state.lastToolCapture = {
                tool: input.tool,
                filePath,
                isError: isErrorResult(String(output?.output ?? "")),
                timestamp: Date.now()
              };
            }
          }
          if (input.tool === "bash") {
            const command = args?.command || "";
            const result = String(output?.output ?? "");
            if (isErrorResult(result)) {
              const stored = await store.store({
                content: `Command failed: ${command.slice(0, 200)} \u2192 ${result.slice(0, 200)}`,
                type: "lesson_learned",
                scope: "project",
                confidence: 0.4,
                tags: ["auto-captured", "bash-error"],
                metadata: {
                  source: "tool.execute.after",
                  tool: "bash",
                  command,
                  severity: "medium"
                }
              });
              if (state.config.autoRelate !== false) {
                void store.maybeRelate(stored.id, stored.content, stored.type).catch(() => {
                });
              }
              await log("debug", "Auto-captured lesson_learned from bash error");
              state.lastToolCapture = {
                tool: input.tool,
                command,
                isError: isErrorResult(result),
                timestamp: Date.now()
              };
            }
          }
        } catch (error) {
          await log(
            "error",
            `Auto-capture failed: ${error instanceof Error ? error.message : String(error)}`
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
    "chat.message": (_input, output) => {
      recordHookFired(getStore, state.probe, "chat.message");
      if (output?.message?.role !== "user") return;
      const content = extractUserText(output?.parts ?? []);
      if (!content) return;
      state.lastInjectedMemoryIds = null;
      state.deltaTurnDone = false;
      const brainLoopEnabled = state.config.brainLoop !== false;
      let recallLimit = 3;
      if (brainLoopEnabled) {
        const intent = classifyIntent(content, "", state.recentUserTexts, state.lastToolCapture);
        state.lastUserText = content;
        state.lastUserIntent = intent;
        recallLimit = dynamicLimit(intent);
        state.recentUserTexts.push(content);
        if (state.recentUserTexts.length > 5) state.recentUserTexts.shift();
      }
      void (async () => {
        try {
          const store = await getStore();
          const config = state.config;
          const results = await store.recall({
            query: content,
            scope: "all",
            limit: recallLimit,
            threshold: config.recallThreshold || 0.3,
            traverse: true
          });
          const newResults = results.filter(
            (r) => !state.injectedMemoryIds.has(r.memory.id)
          );
          if (newResults.length === 0) return;
          newResults.forEach((r) => state.injectedMemoryIds.add(r.memory.id));
          state.lastInjectedMemoryIds = newResults.map((r) => r.memory.id).slice(-5);
          state.pendingInjection = formatRecallResults(newResults);
          await log("info", `Auto-recalled ${newResults.length} memories for user message`);
        } catch (error) {
          await log(
            "error",
            `Message recall failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })();
    },
    // Delivery mechanism: OpenCode builds the LLM request (system prompt)
    // after a user message is received, so any recall block staged by
    // `session.created` or `chat.message` is appended to the system prompt
    // here — and cleared so it is never injected twice.
    "experimental.chat.system.transform": (_input, output) => {
      recordHookFired(getStore, state.probe, "experimental.chat.system.transform");
      const r = pushSentinel(state.probe, output);
      if (r.pushed && !r.assertionOk) {
        recordLandsOutcome(getStore, state.probe, 0);
      }
      if (!state.pendingInjection) return;
      if (!Array.isArray(output?.system)) {
        state.pendingInjection = null;
        return;
      }
      output.system.push(state.pendingInjection);
      state.lastInjectedMemoryIds = Array.from(state.injectedMemoryIds).slice(-5);
      state.pendingInjection = null;
    },
    // On context compaction: run detached hygiene (INV-017) — rate-limited
    // decay under a separate meta key (decay:compacting), a bounded dedup
    // pass, and a bloat-ratio snapshot. The hook resolves immediately; all
    // store work runs on a detached promise and any failure is logged, never
    // thrown out of the handler or the compaction flow.
    "experimental.session.compacting": () => {
      recordHookFired(getStore, state.probe, "experimental.session.compacting");
      void (async () => {
        try {
          const store = await getStore();
          const config = state.config;
          const intervalHours = config.compactingIntervalHours ?? 4;
          await store.maybeDecay("decay:compacting", intervalHours);
          await store.dedupPass();
          await store.recordMetric("memory_bloat_ratio", await store.getBloatRatio());
        } catch (error) {
          await log(
            "error",
            `Compacting hygiene failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })();
    }
  };
}

// src/plugin-entry.ts
var pluginModule = {
  id: "realmemory",
  server: realmemoryPlugin
};
var plugin_entry_default = pluginModule;
export {
  plugin_entry_default as default
};
