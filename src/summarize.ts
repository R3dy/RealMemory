/**
 * Reflective session summarization — turns a session transcript into durable,
 * typed memories via an LLM.
 *
 * The plugin's `session.idle` handler fetches the transcript of a finished
 * session, sends it through {@link callSummaryProvider} with a prompt built by
 * {@link buildSummarizationPrompt}, and stores the structured memories parsed
 * by {@link parseSummarizationResponse}. Every part here is defensive: a
 * malformed or unreachable provider must never throw out of the caller.
 */

import type { MemoryType, SummaryProviderConfig } from "./types";

/** A single structured memory extracted from a transcript by the LLM. */
export interface ExtractedMemory {
  content: string;
  type: MemoryType;
  confidence: number;
  tags: string[];
}

/** The six valid memory types, as a set for fast membership checks. */
const VALID_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>([
  "user_preference",
  "task_pattern",
  "codebase_fact",
  "lesson_learned",
  "session_summary",
  "contextual_note",
]);

/** Default confidence applied when the LLM omits or provides an invalid one. */
const DEFAULT_CONFIDENCE = 0.5;

/** Short human-readable description of each memory type, fed to the LLM. */
const TYPE_DESCRIPTIONS: Record<MemoryType, string> = {
  user_preference: "anything the user stated about how they want things done.",
  task_pattern:
    "recurring approaches/conventions used or asked for.",
  codebase_fact: "structural facts discovered about the project.",
  lesson_learned:
    'not just errors: includes "approach X worked well", "Y was a dead end", any hard-won insight.',
  session_summary: "one summary of what happened, always.",
  contextual_note:
    "anything situational worth keeping that doesn't fit above.",
};

/**
 * Build the LLM prompt that asks a model to extract structured memories from a
 * session transcript. The prompt instructs the model to emit ONLY a JSON array
 * of `{content, type, confidence, tags}` objects, where `type` is one of the
 * six {@link MemoryType} values and each category is described.
 */
export function buildSummarizationPrompt(transcript: string): string {
  const typeLines = (Object.keys(TYPE_DESCRIPTIONS) as MemoryType[])
    .map((t) => `- ${t}: ${TYPE_DESCRIPTIONS[t]}`)
    .join("\n");

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
    "- Always include exactly one entry with type \"session_summary\".",
    "- Do not invent facts — only extract what is actually present in the transcript.",
    "- Do not emit commentary, markdown, or prose outside the JSON array.",
    "",
    "Transcript:",
    '"""',
    transcript,
    '"""',
  ].join("\n");
}

/**
 * Defensively parse the LLM's response into a list of {@link ExtractedMemory}.
 *
 * Tries, in order: a direct `JSON.parse` of the whole response; a JSON array
 * extracted from within a markdown fenced code block (```json ... ```); and the
 * substring between the first `[` and last `]`. If none produce an array, an
 * empty array is returned — this never throws. Each entry is validated:
 * `content` must be a non-empty string, `type` must be one of the six valid
 * values (invalid entries are discarded), `confidence` is clamped to [0, 1],
 * and `tags` defaults to `[]`.
 */
export function parseSummarizationResponse(response: string): ExtractedMemory[] {
  if (typeof response !== "string" || response.trim().length === 0) {
    return [];
  }
  const trimmed = response.trim();

  let parsed: unknown = null;

  // 1. Direct JSON.parse of the whole response.
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = null;
  }

  // 2. JSON inside a markdown fenced code block.
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

  // 3. First '[' to last ']' substring.
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

  const result: ExtractedMemory[] = [];
  for (const entry of parsed) {
    const memory = validateEntry(entry);
    if (memory) result.push(memory);
  }
  return result;
}

/** Validate and normalize a single parsed entry. Returns null to discard it. */
function validateEntry(entry: unknown): ExtractedMemory | null {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;

  if (typeof obj.content !== "string" || obj.content.trim().length === 0) {
    return null;
  }
  if (typeof obj.type !== "string" || !VALID_TYPES.has(obj.type as MemoryType)) {
    return null;
  }

  let confidence =
    typeof obj.confidence === "number" ? obj.confidence : DEFAULT_CONFIDENCE;
  if (!Number.isFinite(confidence)) confidence = DEFAULT_CONFIDENCE;
  confidence = Math.max(0, Math.min(1, confidence));

  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === "string")
    : [];

  return {
    content: obj.content.trim(),
    type: obj.type as MemoryType,
    confidence,
    tags,
  };
}

/**
 * Call an LLM completion provider and return the generated text.
 *
 * Supports the OpenAI-compatible `/chat/completions` endpoint by default, and
 * the Anthropic `/v1/messages` endpoint when the provider is `anthropic`. The
 * request URL is `provider.apiUrl` when set; otherwise it falls back to the
 * provider's well-known endpoint (OpenAI unless `provider.provider` is
 * `anthropic`). The prompt is sent as the single user message with a
 * `response_format: { type: "json_object" }` hint where supported. Throws on
 * HTTP error or an empty response — the caller catches.
 */
export async function callSummaryProvider(
  provider: SummaryProviderConfig,
  prompt: string,
): Promise<string> {
  const model = provider.model;
  const apiKey = provider.apiKey;

  let url = provider.apiUrl;
  if (!url) {
    url =
      provider.provider === "anthropic"
        ? "https://api.anthropic.com/v1/messages"
        : "https://api.openai.com/v1/chat/completions";
  }

  const isAnthropic =
    provider.provider === "anthropic" || url.endsWith("/v1/messages");

  if (isAnthropic) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : {}),
    };
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Summary provider error: ${response.status} ${response.statusText}`,
      );
    }
    const data = (await response.json()) as {
      content?: Array<{ text?: string }>;
    };
    const text = Array.isArray(data?.content)
      ? data.content.map((c) => c?.text ?? "").join("")
      : "";
    if (!text) {
      throw new Error("Summary provider returned no text content");
    }
    return text;
  }

  // OpenAI-compatible /chat/completions.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Summary provider error: ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text =
    typeof data?.choices?.[0]?.message?.content === "string"
      ? data.choices[0].message.content
      : "";
  if (!text) {
    throw new Error("Summary provider returned no text content");
  }
  return text;
}
