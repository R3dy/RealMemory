import {
  checkSentinelLanded,
  createProbeState,
  pushSentinel,
  recordHookFired,
  recordLandsOutcome,
  resetProbeForSession,
  resolveHostVersion
} from "./chunk-2N5IPEKP.js";
import {
  classifyIntent,
  deriveProjectId,
  dynamicLimit,
  evaluateDelta
} from "./chunk-ZV65OZDS.js";
import {
  MemoryStore,
  loadConfig
} from "./chunk-K6MQZMEO.js";
import "./chunk-B5S5KXU7.js";

// src/reflex.ts
var REFLEX_WEIGHT_FLOOR = 0.3;
var REFLEX_RULE_CAP = 100;
var AROUSAL_TEMP_DELTA = 0.15;
var AROUSAL_THRESHOLD = 0.3;
var AROUSAL_NORMALIZATION = 3;
var AROUSAL_WEIGHT_CORRECTION = 1;
var AROUSAL_WEIGHT_BLOCK = 0.8;
var AROUSAL_WEIGHT_HIGH_SURPRISE = 0.6;
var AROUSAL_WINDOW = 5;
var PREFERENCES_CAP = 10;
var SEARCH_LIMIT = 200;
var NOTE_MAX_LENGTH = 120;
function emptyReflexCache() {
  return {
    rules: [],
    preferences: [],
    arousal: 0,
    builtAt: 0
  };
}
function compileRule(memory) {
  if (memory.type !== "lesson_learned") return null;
  const metadata = memory.metadata ?? {};
  const command = typeof metadata.command === "string" ? metadata.command : null;
  const filePath = typeof metadata.filePath === "string" ? metadata.filePath : null;
  let matcher = null;
  let toolName;
  if (command) {
    toolName = "bash";
    const cmdSubstring = command.slice(0, 100);
    matcher = (call) => {
      if (call.tool !== "bash") return false;
      const callCommand = call.args?.command;
      if (typeof callCommand !== "string") return false;
      return callCommand.includes(cmdSubstring);
    };
  } else if (filePath) {
    toolName = "read";
    const pathSubstring = filePath.slice(0, 200);
    matcher = (call) => {
      if (call.tool !== "read") return false;
      const callFilePath = call.args?.filePath;
      if (typeof callFilePath !== "string") return false;
      return callFilePath.includes(pathSubstring);
    };
  }
  if (!matcher) return null;
  const note = memory.content.length > NOTE_MAX_LENGTH ? `${memory.content.slice(0, NOTE_MAX_LENGTH - 3)}...` : memory.content;
  let rewrite;
  const rewriteMeta = metadata.rewrite ?? null;
  if (rewriteMeta && typeof rewriteMeta.from === "string" && typeof rewriteMeta.to === "string" && rewriteMeta.from.length > 0) {
    const from = rewriteMeta.from;
    const to = rewriteMeta.to;
    rewrite = (args) => {
      const cmd = args?.command;
      if (typeof cmd !== "string" || !cmd.includes(from)) return args;
      return { ...args, command: cmd.split(from).join(to) };
    };
  }
  const blockEligible = memory.category === "safety" || memory.category === "cost";
  return {
    memoryId: memory.id,
    match: matcher,
    rewrite,
    blockEligible,
    tool: toolName,
    note,
    salience: Math.max(0, Math.min(1, memory.weight)),
    confidence: Math.max(0, Math.min(1, memory.confidence))
  };
}
async function buildReflexCache(store) {
  const query = {
    types: ["lesson_learned", "user_preference"],
    minWeight: REFLEX_WEIGHT_FLOOR,
    sortBy: "weight",
    sortOrder: "desc",
    limit: SEARCH_LIMIT
  };
  const results = await store.search(query);
  const rules = [];
  const preferences = [];
  for (const memory of results.memories) {
    if (memory.type === "user_preference") {
      preferences.push(memory.content);
      continue;
    }
    const rule = compileRule(memory);
    if (rule) rules.push(rule);
  }
  rules.sort((a, b) => b.salience * b.confidence - a.salience * a.confidence);
  return {
    rules: rules.slice(0, REFLEX_RULE_CAP),
    preferences: preferences.slice(0, PREFERENCES_CAP),
    arousal: 0,
    // Phase 1 stub — Phase 5 (arousal) populates this
    builtAt: Date.now()
  };
}
function matchCall(cache, call) {
  if (!cache || cache.rules.length === 0) return null;
  for (const rule of cache.rules) {
    if (typeof rule.match === "function") {
      if (rule.match(call)) return rule;
    } else {
      const callStr = `${call.tool} ${JSON.stringify(call.args ?? {})}`;
      if (rule.match.test(callStr)) return rule;
    }
  }
  return null;
}
function addRule(cache, rule) {
  cache.rules.push(rule);
  cache.rules.sort(
    (a, b) => b.salience * b.confidence - a.salience * a.confidence
  );
  if (cache.rules.length > REFLEX_RULE_CAP) {
    cache.rules.length = REFLEX_RULE_CAP;
  }
}
var BLOCK_CONFIDENCE_FLOOR = 0.5;
var REWRITE_CONFIDENCE_FLOOR = 0.3;
var BLOCK_SALIENCE_FLOOR = 0.8;
var REWRITE_SALIENCE_FLOOR = 0.5;
var OVERRIDE_CONFIDENCE_DEC = 0.2;
function decideAction(rule, inhibition) {
  if (inhibition === "off" || rule === null) return "none";
  if (inhibition === "warn") return "warn";
  if (inhibition === "block" && rule.salience >= BLOCK_SALIENCE_FLOOR && rule.confidence >= BLOCK_CONFIDENCE_FLOOR && rule.blockEligible) {
    return "block";
  }
  if (rule.salience >= REWRITE_SALIENCE_FLOOR && rule.confidence >= REWRITE_CONFIDENCE_FLOOR && rule.rewrite) {
    return "rewrite";
  }
  return "warn";
}
function decrementRuleConfidence(cache, memoryId, amount) {
  const rule = cache.rules.find((r) => r.memoryId === memoryId);
  if (!rule) return;
  rule.confidence = Math.max(0, rule.confidence - amount);
  cache.rules.sort(
    (a, b) => b.salience * b.confidence - a.salience * a.confidence
  );
}
function emptyArousalTracker() {
  return { signals: [] };
}
function computeArousal(tracker) {
  if (tracker.signals.length === 0) return 0;
  let sum = 0;
  for (const s of tracker.signals) {
    if (s.correction) sum += AROUSAL_WEIGHT_CORRECTION;
    if (s.block) sum += AROUSAL_WEIGHT_BLOCK;
    if (s.highSurprise) sum += AROUSAL_WEIGHT_HIGH_SURPRISE;
  }
  return Math.min(1, sum / AROUSAL_NORMALIZATION);
}
function pushArousalSignal(tracker, signal) {
  tracker.signals.push(signal);
  if (tracker.signals.length > AROUSAL_WINDOW) {
    tracker.signals.shift();
  }
}
function matchTool(cache, toolName) {
  if (!cache || cache.rules.length === 0) return null;
  for (const rule of cache.rules) {
    if (rule.tool === toolName) return rule;
  }
  return null;
}

// src/predict.ts
function predictOutcome(matchedRule) {
  if (matchedRule) {
    return {
      willSucceed: false,
      confidence: matchedRule.confidence,
      sourceMemoryId: matchedRule.memoryId
    };
  }
  return {
    willSucceed: true,
    confidence: 0.5,
    sourceMemoryId: null
  };
}
function classifyOutcome(tool, output, isErrorResult2) {
  if (tool === "bash") {
    return { success: !isErrorResult2(String(output ?? "")) };
  }
  if (output instanceof Error) {
    return { success: false };
  }
  if (typeof output === "string" && /error:/i.test(output)) {
    return { success: false };
  }
  return { success: true };
}
function computeSurprise(prediction, actual) {
  const expected = prediction.willSucceed ? prediction.confidence : 1 - prediction.confidence;
  const actualValue = actual.success ? 1 : 0;
  return Math.abs(actualValue - expected);
}
function shouldEncode(surprise) {
  return surprise >= 0.2;
}
function surpriseBin(surprise) {
  if (surprise < 0.2) return "low";
  if (surprise > 0.7) return "high";
  return "med";
}
function describe(call, actual) {
  const args = call.args ?? {};
  const detail = args.command ?? args.filePath ?? "";
  const detailTrunc = detail.slice(0, 200);
  const expected = actual.success ? "success" : "failure";
  const observed = actual.success ? "success" : "error";
  const suffix = detailTrunc ? ` \u2014 ${detailTrunc}` : "";
  return `Prediction error (${call.tool}): expected ${expected}, observed ${observed}${suffix}`;
}
function hashArgs(args) {
  if (!args || typeof args !== "object") return "";
  try {
    const stable = JSON.stringify(sortKeys(args));
    return stable.slice(0, 200);
  } catch {
    return "";
  }
}
function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys(value[key]);
    }
    return sorted;
  }
  return value;
}
function consumePrediction(pending, tool, args) {
  const fullPrefix = `${tool}:${hashArgs(args)}:`;
  const toolPrefix = `${tool}:`;
  const keys = Array.from(pending.keys()).reverse();
  for (const key of keys) {
    if (key.startsWith(fullPrefix)) return key;
  }
  for (const key of keys) {
    if (key.startsWith(toolPrefix)) return key;
  }
  return null;
}

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

// src/working-memory.ts
function emptySlot() {
  return { content: "", memoryIds: [] };
}
function emptySlots() {
  return {
    identity: emptySlot(),
    taskFrame: emptySlot(),
    queriedLessons: emptySlot(),
    freshLessons: emptySlot(),
    openPredictions: emptySlot()
  };
}
var SLOT_BUDGETS = {
  identity: 150,
  taskFrame: 200,
  activeLessons: 300,
  // merged queriedLessons + freshLessons, shared budget
  openPredictions: 150
};
var DEFAULT_WORKING_MEMORY_TOKENS = 800;
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function truncateToTokens(content, budget) {
  if (estimateTokens(content) <= budget) return content;
  const lines = content.split("\n");
  let result = "";
  for (const line of lines) {
    const candidate = result ? result + "\n" + line : line;
    if (estimateTokens(candidate) > budget) break;
    result = candidate;
  }
  return result;
}
function truncateSlotContent(content, memoryIds, budget) {
  if (estimateTokens(content) <= budget) {
    return { content, survivingIds: memoryIds };
  }
  const truncated = truncateToTokens(content, budget);
  const ratio = estimateTokens(truncated) / Math.max(estimateTokens(content), 1);
  const survivingCount = Math.ceil(memoryIds.length * ratio);
  return { content: truncated, survivingIds: memoryIds.slice(0, survivingCount) };
}
function assembleWorkingMemory(slots, pendingWarnNote, config) {
  const totalBudget = config.workingMemoryTokens ?? DEFAULT_WORKING_MEMORY_TOKENS;
  const activeLessonsBudget = SLOT_BUDGETS.activeLessons;
  let activeLessonsParts = [];
  let activeLessonsIds = [];
  if (pendingWarnNote) {
    activeLessonsParts.push(pendingWarnNote);
  }
  if (slots.freshLessons.content) {
    activeLessonsParts.push(slots.freshLessons.content);
    activeLessonsIds.push(...slots.freshLessons.memoryIds);
  }
  if (slots.queriedLessons.content) {
    activeLessonsParts.push(slots.queriedLessons.content);
    activeLessonsIds.push(...slots.queriedLessons.memoryIds);
  }
  const activeLessonsRaw = activeLessonsParts.join("\n");
  let activeLessonsTruncated = truncateSlotContent(activeLessonsRaw, activeLessonsIds, activeLessonsBudget);
  const identityTruncated = truncateSlotContent(
    slots.identity.content,
    slots.identity.memoryIds,
    SLOT_BUDGETS.identity
  );
  const taskFrameTruncated = truncateSlotContent(
    slots.taskFrame.content,
    slots.taskFrame.memoryIds,
    SLOT_BUDGETS.taskFrame
  );
  const openPredictionsTruncated = truncateSlotContent(
    slots.openPredictions.content,
    slots.openPredictions.memoryIds,
    SLOT_BUDGETS.openPredictions
  );
  const hasIdentity = identityTruncated.content.length > 0;
  const hasTaskFrame = taskFrameTruncated.content.length > 0;
  const hasActiveLessons = activeLessonsTruncated.content.length > 0;
  const hasOpenPredictions = openPredictionsTruncated.content.length > 0;
  const hasWarnNote = pendingWarnNote !== null && pendingWarnNote.length > 0;
  if (!hasIdentity && !hasTaskFrame && !hasActiveLessons && !hasOpenPredictions && !hasWarnNote) {
    return { formatted: null, deliveredMemoryIds: [] };
  }
  const protectedTokens = estimateTokens(identityTruncated.content) + estimateTokens(taskFrameTruncated.content);
  const remainingBudget = Math.max(0, totalBudget - protectedTokens);
  const activeLessonsCurrent = estimateTokens(activeLessonsTruncated.content);
  const openPredictionsCurrent = estimateTokens(openPredictionsTruncated.content);
  let activeLessonsFinal = activeLessonsTruncated;
  let openPredictionsFinal = openPredictionsTruncated;
  if (activeLessonsCurrent + openPredictionsCurrent > remainingBudget) {
    const afterOpenPredictionsTrim = Math.max(0, remainingBudget - activeLessonsCurrent);
    if (openPredictionsCurrent > afterOpenPredictionsTrim) {
      openPredictionsFinal = truncateSlotContent(
        openPredictionsTruncated.content,
        openPredictionsTruncated.survivingIds,
        afterOpenPredictionsTrim
      );
    }
    const stillOver = estimateTokens(activeLessonsFinal.content) + estimateTokens(openPredictionsFinal.content) > remainingBudget;
    if (stillOver) {
      const activeLessonsAllowed = remainingBudget - estimateTokens(openPredictionsFinal.content);
      activeLessonsFinal = truncateSlotContent(
        activeLessonsTruncated.content,
        activeLessonsTruncated.survivingIds,
        Math.max(0, activeLessonsAllowed)
      );
    }
  }
  const sections = ["## Working memory", ""];
  if (hasIdentity) {
    sections.push(identityTruncated.content);
    sections.push("");
  }
  if (hasTaskFrame) {
    sections.push("### Task");
    sections.push(taskFrameTruncated.content);
    sections.push("");
  }
  if (activeLessonsFinal.content.length > 0) {
    sections.push("### Active lessons");
    sections.push(activeLessonsFinal.content);
    sections.push("");
  }
  if (openPredictionsFinal.content.length > 0) {
    sections.push(openPredictionsFinal.content);
    sections.push("");
  }
  const formatted = sections.join("\n").trimEnd();
  const deliveredMemoryIds = taskFrameTruncated.survivingIds;
  return { formatted, deliveredMemoryIds };
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
function blockMessage(rule) {
  return `Blocked by realmemory: ${rule.note} (memory ${rule.memoryId}). If this is intentional, retry the command and it will be recorded as an exception.`;
}
function safeArgsKey(args) {
  try {
    return JSON.stringify(sortKeys(args));
  } catch {
    return "";
  }
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
    pendingPredictions: /* @__PURE__ */ new Map(),
    predictionCounter: 0,
    lastPredictionOutcome: null,
    lastBlock: null,
    arousalTracker: emptyArousalTracker()
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
  function recordWorkingMemoryMetrics(getStore2, sessionId, slots) {
    void (async () => {
      try {
        const store = await getStore2();
        const slotNames = [
          ["identity", slots.identity],
          ["taskFrame", slots.taskFrame],
          ["queriedLessons", slots.queriedLessons],
          ["freshLessons", slots.freshLessons],
          ["openPredictions", slots.openPredictions]
        ];
        for (const [name, slot] of slotNames) {
          if (slot.content.length > 0) {
            await store.recordMetric(`working_memory:${name}`, 1, sessionId ?? void 0);
          }
        }
      } catch {
      }
    })();
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
        state.arousalTracker = emptyArousalTracker();
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
            state.workingMemory.taskFrame = {
              content: formatRecallResults(results),
              memoryIds: results.map((r) => r.memory.id)
            };
            await log("info", `Auto-recalled ${results.length} memories for new session`);
          }
          const brainConfigWM = state.config;
          if (brainConfigWM.brain?.workingMemory !== false) {
            try {
              const idResults = await store.search({
                scope: "global",
                types: ["user_preference"],
                sortBy: "weight",
                sortOrder: "desc",
                limit: 1
              });
              if (idResults.memories.length > 0) {
                const m = idResults.memories[0];
                state.workingMemory.identity = {
                  content: m.content,
                  memoryIds: [m.id]
                };
              }
            } catch {
            }
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
        if (state.config.brain?.reflex !== false) {
          void (async () => {
            try {
              const store = await getStore();
              state.reflexCache = await buildReflexCache(store);
              await log("debug", `ReflexCache built: ${state.reflexCache.rules.length} rules`);
            } catch (error) {
              await log(
                "error",
                `ReflexCache build failed: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          })();
        }
      }
      if (event.type === "session.idle") {
        recordHookFired(getStore, state.probe, "event:session.idle");
        pushArousalSignal(state.arousalTracker, {
          correction: state.lastUserIntent === "correction",
          block: state.lastBlock !== null,
          highSurprise: state.lastPredictionOutcome !== null && state.lastPredictionOutcome.surprise >= 0.5
        });
        if (state.reflexCache) {
          state.reflexCache.arousal = computeArousal(state.arousalTracker);
        }
        state.pendingPredictions.clear();
        state.lastPredictionOutcome = null;
        state.lastBlock = null;
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
    "tool.execute.before": (input, output) => {
      recordHookFired(getStore, state.probe, "tool.execute.before");
      const brainConfig = state.config;
      const inhibition = brainConfig.brain?.inhibition ?? "warn";
      const currentArgs = input.args ?? output.args ?? {};
      const currentArgsKey = safeArgsKey(currentArgs);
      if (state.lastBlock && state.lastBlock.tool === input.tool && state.lastBlock.argsKey === currentArgsKey) {
        const blocked = state.lastBlock;
        state.lastBlock = null;
        const memId = blocked.memoryId;
        const newConfidence = Math.max(0, blocked.confidence - OVERRIDE_CONFIDENCE_DEC);
        if (state.reflexCache) {
          decrementRuleConfidence(state.reflexCache, memId, OVERRIDE_CONFIDENCE_DEC);
        }
        void (async () => {
          try {
            const store = await getStore();
            await store.recordMetric(`reflex_override:${memId}`, 1, state.sessionId ?? void 0);
            await store.update(memId, { confidence: newConfidence }).catch(() => {
            });
          } catch {
          }
        })();
        if (brainConfig.brain?.predictionError !== false) {
          const cache2 = state.reflexCache;
          const rule2 = cache2 && cache2.rules.length > 0 ? matchCall(cache2, { tool: input.tool, args: currentArgs }) : null;
          const prediction = predictOutcome(rule2);
          const callId = `${input.tool}:${hashArgs(currentArgs)}:${state.predictionCounter++}`;
          state.pendingPredictions.set(callId, prediction);
        }
        return;
      }
      state.lastBlock = null;
      const cache = state.reflexCache;
      const rule = cache && cache.rules.length > 0 ? matchCall(cache, { tool: input.tool, args: input.args ?? output.args }) : null;
      const action = decideAction(rule, inhibition);
      if (action === "block" && rule) {
        state.lastBlock = {
          tool: input.tool,
          argsKey: currentArgsKey,
          memoryId: rule.memoryId,
          confidence: rule.confidence
        };
        void (async () => {
          try {
            const store = await getStore();
            await store.recordMetric(
              `reflex_block:${rule.memoryId}`,
              1,
              state.sessionId ?? void 0
            );
          } catch {
          }
        })();
        if (brainConfig.brain?.predictionError !== false) {
          const prediction = predictOutcome(rule);
          const callId = `${input.tool}:${hashArgs(currentArgs)}:${state.predictionCounter++}`;
          state.pendingPredictions.set(callId, prediction);
        }
        throw new Error(blockMessage(rule));
      }
      if (action === "rewrite" && rule?.rewrite) {
        const origArgs = output.args ?? input.args ?? {};
        const rewritten = rule.rewrite(origArgs);
        if (rewritten !== origArgs) {
          output.args = rewritten;
          void (async () => {
            try {
              const store = await getStore();
              await store.recordMetric(
                `reflex_rewrite:${rule.memoryId}`,
                1,
                state.sessionId ?? void 0
              );
            } catch {
            }
          })();
          state.pendingWarnNote = `[realmemory reflex] Rewrote args: ${rule.note}`;
        } else {
          state.pendingWarnNote = `[realmemory reflex] ${rule.note}`;
          void (async () => {
            try {
              const store = await getStore();
              await store.recordMetric(
                `reflex_fire:${rule.memoryId}`,
                1,
                state.sessionId ?? void 0
              );
            } catch {
            }
          })();
        }
      } else if (action === "warn" && rule) {
        state.pendingWarnNote = `[realmemory reflex] ${rule.note}`;
        void (async () => {
          try {
            const store = await getStore();
            await store.recordMetric(
              `reflex_fire:${rule.memoryId}`,
              1,
              state.sessionId ?? void 0
            );
          } catch {
          }
        })();
      }
      if (brainConfig.brain?.predictionError !== false) {
        const prediction = predictOutcome(rule);
        const callId = `${input.tool}:${hashArgs(input.args ?? output.args)}:${state.predictionCounter++}`;
        state.pendingPredictions.set(callId, prediction);
      }
    },
    // On tool execution: auto-capture learnings (if enabled, default true) +
    // synthetic-brain Phase 2: prediction error (surprise-driven encoding).
    // Non-blocking: the handler resolves immediately and all store work (DB
    // init + write) runs on a detached promise, so a slow write never blocks
    // the tool loop. Errors are logged, never thrown out of the handler.
    "tool.execute.after": (input, output) => {
      recordHookFired(getStore, state.probe, "tool.execute.after");
      const captureConfig = state.config;
      const brainConfig = state.config;
      if (captureConfig?.autoCapture === false && brainConfig.brain?.predictionError === false)
        return;
      void (async () => {
        try {
          const store = await getStore();
          const args = input?.args ?? output?.args ?? {};
          if (captureConfig?.autoCapture !== false) {
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
          }
          if (brainConfig.brain?.predictionError !== false) {
            const callId = consumePrediction(
              state.pendingPredictions,
              input.tool,
              input.args ?? output?.args
            );
            if (callId) {
              const prediction = state.pendingPredictions.get(callId);
              state.pendingPredictions.delete(callId);
              const actual = classifyOutcome(input.tool, output?.output, isErrorResult);
              const surprise = computeSurprise(prediction, actual);
              const bin = surpriseBin(surprise);
              await store.recordMetric(
                `prediction_error:${bin}`,
                1,
                state.sessionId ?? void 0
              );
              let encodedMemoryId = null;
              if (shouldEncode(surprise)) {
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
                    command: args?.command ?? null,
                    filePath: args?.filePath ?? null
                  }
                });
                encodedMemoryId = m.id;
                if (state.config.autoRelate !== false) {
                  void store.maybeRelate(m.id, m.content, m.type).catch(() => {
                  });
                }
                if (surprise > 0.7 && state.reflexCache) {
                  const newRule = compileRule(m);
                  if (newRule) addRule(state.reflexCache, newRule);
                }
                await log("debug", `Prediction error: encoded lesson (surprise=${surprise.toFixed(2)}, bin=${bin})`);
              } else if (prediction.sourceMemoryId) {
                await store.update(prediction.sourceMemoryId, { reinforce: true }).catch(() => {
                });
              }
              state.lastPredictionOutcome = {
                prediction,
                actual,
                surprise,
                encodedMemoryId
              };
              if (shouldEncode(surprise) && encodedMemoryId) {
                state.workingMemory.freshLessons = {
                  content: `- ${describe({ tool: input.tool, args }, actual)}`,
                  memoryIds: [encodedMemoryId]
                };
              }
              if (surprise >= 0.2) {
                state.workingMemory.openPredictions = {
                  content: `**Prediction error** (${input.tool}): expected ${actual.success ? "failure" : "success"}, observed ${actual.success ? "success" : "error"} (surprise=${surprise.toFixed(2)})`,
                  memoryIds: encodedMemoryId ? [encodedMemoryId] : []
                };
              }
            }
          }
        } catch (error) {
          await log(
            "error",
            `Auto-capture/prediction failed: ${error instanceof Error ? error.message : String(error)}`
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
      let intent = "generic";
      if (brainLoopEnabled) {
        intent = classifyIntent(content, "", state.recentUserTexts, state.lastToolCapture);
        state.lastUserText = content;
        state.lastUserIntent = intent;
        recallLimit = dynamicLimit(intent);
        state.recentUserTexts.push(content);
        if (state.recentUserTexts.length > 5) state.recentUserTexts.shift();
      }
      const brainConfigPred = state.config;
      if (intent === "correction" && brainConfigPred.brain?.predictionError !== false && state.lastPredictionOutcome) {
        const outcome = state.lastPredictionOutcome;
        state.lastPredictionOutcome = null;
        void (async () => {
          try {
            const store = await getStore();
            if (outcome.encodedMemoryId) {
              await store.update(outcome.encodedMemoryId, {
                reinforce: true,
                confidence: 0.8
                // 0.4 + 0.4 * 1.0
              }).catch(() => {
              });
              await store.recordMetric(
                "prediction_error:high",
                1,
                state.sessionId ?? void 0
              );
            } else {
              const m = await store.store({
                content: `User correction (max prediction error): ${content.slice(0, 200)}`,
                type: "lesson_learned",
                scope: "project",
                confidence: 0.8,
                // 0.4 + 0.4 * 1.0
                tags: ["prediction-error", "user-correction"],
                metadata: {
                  surprise: 1,
                  predicted: outcome.prediction,
                  actual: outcome.actual,
                  source: "prediction-error",
                  intent: "correction"
                }
              });
              void store.maybeRelate(m.id, m.content, m.type).catch(() => {
              });
              await store.recordMetric(
                "prediction_error:high",
                1,
                state.sessionId ?? void 0
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
              `Prediction-error correction failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        })();
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
          if (newResults.length > 0) {
            newResults.forEach((r) => state.injectedMemoryIds.add(r.memory.id));
            state.workingMemory.taskFrame = {
              content: formatRecallResults(newResults),
              memoryIds: newResults.map((r) => r.memory.id)
            };
            await log("info", `Auto-recalled ${newResults.length} memories for user message`);
          }
          const brainConfigWM = state.config;
          if (brainConfigWM.brain?.workingMemory !== false) {
            try {
              const lessonResults = await store.search({
                types: ["lesson_learned"],
                scope: "all",
                minWeight: 0.3,
                sortBy: "weight",
                sortOrder: "desc",
                limit: 5
              });
              if (lessonResults.memories.length > 0) {
                const lessonTexts = lessonResults.memories.map((m) => `- ${m.content.slice(0, 200)}`);
                state.workingMemory.queriedLessons = {
                  content: lessonTexts.join("\n"),
                  memoryIds: lessonResults.memories.map((m) => m.id)
                };
              }
            } catch {
            }
          }
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
    // here. Phase 3: replaced the one-shot pendingInjection with a budgeted,
    // slotted working-memory window rebuilt every turn.
    "experimental.chat.system.transform": (_input, output) => {
      recordHookFired(getStore, state.probe, "experimental.chat.system.transform");
      const r = pushSentinel(state.probe, output);
      if (r.pushed && !r.assertionOk) {
        recordLandsOutcome(getStore, state.probe, 0);
      }
      if (!Array.isArray(output?.system)) {
        state.pendingWarnNote = null;
        return;
      }
      const brainConfig = state.config;
      if (brainConfig.brain?.workingMemory === false) {
        if (state.pendingWarnNote) {
          output.system.push(state.pendingWarnNote);
          state.pendingWarnNote = null;
        }
        return;
      }
      const { formatted, deliveredMemoryIds } = assembleWorkingMemory(
        state.workingMemory,
        state.pendingWarnNote,
        { workingMemoryTokens: brainConfig.brain?.workingMemoryTokens }
      );
      if (formatted) {
        output.system.push(formatted);
        state.lastInjectedMemoryIds = state.workingMemory.taskFrame.memoryIds.slice(-5);
        deliveredMemoryIds.forEach((id) => state.injectedMemoryIds.add(id));
        recordWorkingMemoryMetrics(getStore, state.sessionId, state.workingMemory);
      }
      state.workingMemory.openPredictions = { content: "", memoryIds: [] };
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
      recordHookFired(getStore, state.probe, "experimental.session.compacting");
      state.injectedMemoryIds.clear();
      state.workingMemory.taskFrame = { content: "", memoryIds: [] };
      state.workingMemory.queriedLessons = { content: "", memoryIds: [] };
      state.workingMemory.freshLessons = { content: "", memoryIds: [] };
      state.workingMemory.openPredictions = { content: "", memoryIds: [] };
      void (async () => {
        try {
          const store = await getStore();
          const config = state.config;
          const intervalHours = config.compactingIntervalHours ?? 4;
          await store.maybeDecay("decay:compacting", intervalHours);
          await store.dedupPass();
          await store.recordMetric("memory_bloat_ratio", await store.getBloatRatio());
          const brainConfig = state.config;
          if (brainConfig.brain?.schemaFormation !== false) {
            const { consolidatePass } = await import("./consolidate-GVQGGQEN.js");
            const rules = await consolidatePass(
              store,
              state.config
            );
            if (rules > 0) {
              await store.recordMetric("schema_formation", rules);
            }
          }
        } catch (error) {
          await log(
            "error",
            `Compacting hygiene failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })();
    },
    // Synthetic-brain Phase 5: arousal-based temperature modulation.
    // Reflex path (ADR-010): synchronous, cache-only, <5ms. Reads
    // ReflexCache.arousal (in-RAM) and clamps temperature DOWN by up to 0.15.
    // Never increases temperature above the agent's setting. Default off
    // (brain.arousalModulation !== false gate).
    "chat.params": (_input, output) => {
      recordHookFired(getStore, state.probe, "chat.params");
      const brainConfig = state.config;
      if (brainConfig.brain?.arousalModulation !== true) return;
      const cache = state.reflexCache;
      if (!cache || cache.arousal < AROUSAL_THRESHOLD) return;
      if (typeof output.temperature === "number" && output.temperature > 0) {
        const delta = cache.arousal * AROUSAL_TEMP_DELTA;
        const newTemp = Math.max(0, output.temperature - delta);
        output.temperature = newTemp;
        void (async () => {
          try {
            const store = await getStore();
            await store.recordMetric("arousal_modulation", delta, state.sessionId ?? void 0);
          } catch {
          }
        })();
      }
    },
    // Synthetic-brain Phase 5: memory notes in tool descriptions.
    // Reflex path (ADR-010): synchronous, cache-only, <5ms. Appends a one-line
    // note from the top reflex rule to the tool's description. Default off
    // (brain.toolDefinitionNotes !== false gate).
    "tool.definition": (input, output) => {
      recordHookFired(getStore, state.probe, "tool.definition");
      const brainConfig = state.config;
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
          await store.recordMetric(`tool_definition_note:${rule.memoryId}`, 1, state.sessionId ?? void 0);
        } catch {
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
