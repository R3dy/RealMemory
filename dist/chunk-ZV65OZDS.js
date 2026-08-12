// src/project-id.ts
import { createHash } from "crypto";
function deriveProjectId(cwd) {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

// src/brain-loop.ts
var CORRECTION_PATTERNS = [
  /\bno[,.]?\s+(use|try|do|not|don't)\b/i,
  /\b(not|don't|do not)\s+(use|use|want|need)\b/i,
  /\bactually[,.]?\s+(use|it's|its|try|do)\b/i,
  /\binstead\s+of\b/i,
  /\bi\s+(said|meant|told you)\b/i,
  /\bwrong[,.]?\s/i,
  /\bthat's\s+(not|wrong|incorrect)\b/i,
  /\bstop\s+(using|doing)\b/i
];
var PREFERENCE_PATTERNS = [
  /\balways\s+/i,
  /\bnever\s+/i,
  /\bprefer\s+/i,
  /\bdon't\s+ever\s+/i,
  /\bmake\s+sure\s+(you|to)\s+/i,
  /\bfrom\s+now\s+on\b/i
];
function classifyIntent(userText, _assistantText, recentUserTexts, lastToolCapture) {
  if (CORRECTION_PATTERNS.some((p) => p.test(userText))) {
    return "correction";
  }
  if (PREFERENCE_PATTERNS.some((p) => p.test(userText))) {
    return "preference";
  }
  const normalized = userText.trim().toLowerCase().slice(0, 200);
  if (normalized.length > 0 && recentUserTexts.some((t) => t.trim().toLowerCase().slice(0, 200) === normalized)) {
    return "repetition";
  }
  if (lastToolCapture) {
    return "tool_outcome";
  }
  return "generic";
}
function isHighSignal(intent) {
  return intent === "correction" || intent === "repetition" || intent === "preference" || intent === "tool_outcome";
}
function dynamicLimit(intent) {
  switch (intent) {
    case "correction":
    case "preference":
      return 5;
    case "repetition":
      return 5;
    case "tool_outcome":
      return 5;
    case "generic":
    default:
      return 3;
  }
}
function buildContent(intent, userText, lastToolCapture) {
  switch (intent) {
    case "correction":
      return "User corrected the agent: " + userText.slice(0, 200);
    case "repetition":
      return "Repeated request: " + userText.slice(0, 200);
    case "preference":
      return "User preference: " + userText.slice(0, 200);
    case "tool_outcome":
      if (!lastToolCapture) return "Tool outcome: (no capture)";
      return "Tool outcome (" + lastToolCapture.tool + "): " + (lastToolCapture.isError ? "error" : "success") + " \u2014 " + (lastToolCapture.command || lastToolCapture.filePath || "").slice(0, 120);
    default:
      return "";
  }
}
function intentToType(intent) {
  switch (intent) {
    case "correction":
    case "tool_outcome":
      return "lesson_learned";
    case "repetition":
      return "task_pattern";
    case "preference":
      return "user_preference";
    default:
      return "contextual_note";
  }
}
async function evaluateDelta(store, state, userText, assistantText) {
  if (userText === null || userText === "") return;
  if (state.lastUserIntent === null) return;
  const intent = state.lastUserIntent;
  if (!isHighSignal(intent)) {
    await store.recordMetric("preference_compliance", 1);
    return;
  }
  const content = buildContent(intent, userText, state.lastToolCapture);
  const type = intentToType(intent);
  const stored = await store.store({
    content,
    type,
    scope: "project",
    confidence: intent === "correction" || intent === "preference" ? 0.6 : 0.5,
    tags: [intent, "auto-brain-loop"],
    concise: true,
    metadata: { intent, source: "evaluateDelta" }
  });
  if (state.config.autoRelate !== false) {
    try {
      await store.maybeRelate(stored.id, content, type);
    } catch {
    }
  }
  if (stored.reinforcementCount > 0 && stored.createdAt !== stored.updatedAt) {
    await store.recordMetric("duplicate_rate", 1);
  }
  if (intent === "correction") {
    await store.recordMetric("correction_stored", 1);
  }
  if (state.lastInjectedMemoryIds && state.lastInjectedMemoryIds.length > 0) {
    if (assistantText && assistantText.length > 0) {
      await store.recordMetric("recall_hit", 1);
    } else {
      await store.recordMetric("recall_miss", 1);
    }
  }
}

export {
  deriveProjectId,
  classifyIntent,
  isHighSignal,
  dynamicLimit,
  evaluateDelta
};
