import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import realmemoryPlugin, { type OpenCodePluginContext } from "../src/plugin";
import {
  buildSummarizationPrompt,
  parseSummarizationResponse,
  callSummaryProvider,
} from "../src/summarize";
import { MemoryStore } from "../src/store";
import { deriveProjectId } from "../src/project-id";
import { generateUlid } from "../src/db/ulid";
import type { SummaryProviderConfig } from "../src/types";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `sum-${generateUlid()}.db`);
}

/** Fake `Response`-shaped object for stubbed `global.fetch`. */
function mockJsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

/** A transcript with a user preference, a codebase fact, a lesson, and a summary. */
const SAMPLE_TRANSCRIPT = [
  { role: "user", content: "Please set up the project skeleton and keep everything under src/." },
  {
    role: "assistant",
    content: "I created the src/ directory with a store module. The project uses SQLite with WAL mode enabled.",
  },
  { role: "user", content: "Remember to always run the linter before committing. The build passed cleanly." },
  {
    role: "assistant",
    content: "The linter-first approach worked well — it caught two type errors before the build even started.",
  },
];

const SAMPLE_MEMORIES = [
  {
    content: "The user wants all code kept under src/.",
    type: "user_preference",
    confidence: 0.9,
    tags: ["organization"],
  },
  {
    content: "The project uses SQLite with WAL mode.",
    type: "codebase_fact",
    confidence: 0.8,
    tags: ["database"],
  },
  {
    content: "Running the linter before committing worked well and prevented build failures.",
    type: "lesson_learned",
    confidence: 0.85,
    tags: ["workflow"],
  },
  {
    content: "Session covered project setup, codebase structure, and a lint workflow.",
    type: "session_summary",
    confidence: 0.6,
    tags: ["summary"],
  },
];

/** Build a plugin context pointing at a temp project dir with keyword-only mode. */
function makeContext(opts?: {
  autoSummarize?: boolean;
  summaryProvider?: SummaryProviderConfig;
  logSpy?: ReturnType<typeof vi.fn>;
  messagesMock?: ReturnType<typeof vi.fn>;
}): { ctx: OpenCodePluginContext; projectDir: string; dbPath: string } {
  const dbPath = uniqueDbPath();
  const projectDir = join(tempDir, `proj-${generateUlid()}`);
  mkdirSync(projectDir, { recursive: true });
  const cfgDir = join(projectDir, ".realmemory");
  mkdirSync(cfgDir, { recursive: true });
  const projectConfig: Record<string, unknown> = {
    embeddingModel: null,
    storagePath: dbPath,
    autoCapture: false,
    autoSummarize: opts?.autoSummarize ?? false,
    recallThreshold: 0.0,
    maxRecallResults: 10,
  };
  if (opts?.summaryProvider) {
    projectConfig.summaryProvider = opts.summaryProvider;
  }
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify(projectConfig));

  const logSpy = opts?.logSpy ?? vi.fn().mockResolvedValue(undefined);
  const messagesMock = opts?.messagesMock ?? vi.fn().mockResolvedValue([]);

  const ctx: OpenCodePluginContext = {
    project: { path: projectDir, name: "test-project" },
    client: { app: { log: logSpy }, messages: messagesMock },
    $: {},
    directory: projectDir,
    worktree: projectDir,
  };
  return { ctx, projectDir, dbPath };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-summarize-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/* --------------------------- buildSummarizationPrompt --------------------------- */

describe("buildSummarizationPrompt", () => {
  it("contains all six memory type names", () => {
    const prompt = buildSummarizationPrompt("hello world");
    for (const type of [
      "user_preference",
      "task_pattern",
      "codebase_fact",
      "lesson_learned",
      "session_summary",
      "contextual_note",
    ]) {
      expect(prompt).toContain(type);
    }
  });

  it("requests a JSON array of {content, type, confidence, tags} objects", () => {
    const prompt = buildSummarizationPrompt("hello world");
    expect(prompt).toMatch(/JSON array/);
    expect(prompt).toContain('"content"');
    expect(prompt).toContain('"type"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"tags"');
    expect(prompt).toContain('"session_summary"');
  });

  it("includes the transcript text", () => {
    const transcript = "user: build a parser\nassistant: done";
    const prompt = buildSummarizationPrompt(transcript);
    expect(prompt).toContain(transcript);
  });
});

/* --------------------------- parseSummarizationResponse --------------------------- */

describe("parseSummarizationResponse", () => {
  it("parses a valid JSON array", () => {
    const out = parseSummarizationResponse(
      JSON.stringify([
        { content: "Keep code under src/", type: "user_preference", confidence: 0.9, tags: ["org"] },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      content: "Keep code under src/",
      type: "user_preference",
      confidence: 0.9,
      tags: ["org"],
    });
  });

  it("returns an empty array for malformed JSON", () => {
    expect(parseSummarizationResponse("this is not json at all")).toEqual([]);
    expect(parseSummarizationResponse("")).toEqual([]);
    expect(parseSummarizationResponse('{"content": "not an array"}')).toEqual([]);
  });

  it("parses JSON inside a markdown code block", () => {
    const json = JSON.stringify([
      { content: "SQLite with WAL", type: "codebase_fact", confidence: 0.8 },
    ]);
    const out = parseSummarizationResponse("Here you go:\n```json\n" + json + "\n```\n");
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("SQLite with WAL");
    expect(out[0].type).toBe("codebase_fact");
  });

  it("parses the first-[ … last-] substring when wrapped in prose", () => {
    const json = JSON.stringify([
      { content: "Wrote a parser", type: "task_pattern", confidence: 0.7 },
    ]);
    const out = parseSummarizationResponse(
      `Sure! The extracted memories are ${json} — hope that helps.`,
    );
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("Wrote a parser");
  });

  it("discards entries with an invalid type", () => {
    const out = parseSummarizationResponse(
      JSON.stringify([
        { content: "Valid one", type: "lesson_learned", confidence: 0.5 },
        { content: "Bad type", type: "random_note", confidence: 0.5 },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("Valid one");
  });

  it("discards entries with missing or empty content", () => {
    const out = parseSummarizationResponse(
      JSON.stringify([
        { content: "", type: "codebase_fact", confidence: 0.5 },
        { type: "codebase_fact", confidence: 0.5 },
        "not an object",
        null,
      ]),
    );
    expect(out).toEqual([]);
  });

  it("clamps confidence to [0, 1] and defaults tags to []", () => {
    const out = parseSummarizationResponse(
      JSON.stringify([
        { content: "Too high", type: "user_preference", confidence: 1.7 },
        { content: "Too low", type: "user_preference", confidence: -0.3, tags: ["a", 7, "b"] },
        { content: "No confidence", type: "user_preference", tags: undefined },
      ]),
    );
    expect(out).toHaveLength(3);
    expect(out[0].confidence).toBe(1);
    expect(out[1].confidence).toBe(0);
    expect(out[1].tags).toEqual(["a", "b"]);
    expect(out[2].confidence).toBe(0.5);
    expect(out[2].tags).toEqual([]);
  });
});

/* --------------------------- callSummaryProvider --------------------------- */

describe("callSummaryProvider", () => {
  it("posts to the configured apiUrl with the OpenAI-compatible body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockJsonResponse({ choices: [{ message: { content: "ok" } }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider: SummaryProviderConfig = {
      provider: "openai",
      model: "gpt-4o-mini",
      apiUrl: "https://llm.example.com/v1/chat/completions",
      apiKey: "secret-key",
    };
    const result = await callSummaryProvider(provider, "extract memories");
    expect(result).toBe("ok");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      response_format: { type: string };
    };
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain("extract memories");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-key",
    );
  });

  it("defaults to the OpenAI endpoint when apiUrl is unset", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockJsonResponse({ choices: [{ message: { content: "ok" } }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await callSummaryProvider(
      { provider: "openai", model: "gpt-4o-mini", apiKey: "k" },
      "hi",
    );
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("uses the Anthropic endpoint and response shape for an anthropic provider", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockJsonResponse({ content: [{ type: "text", text: "[]" }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callSummaryProvider(
      { provider: "anthropic", model: "claude-3-5-sonnet", apiKey: "k" },
      "hi",
    );
    expect(result).toBe("[]");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("claude-3-5-sonnet");
    expect(body.messages[0].content).toContain("hi");
  });

  it("throws on an HTTP error response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockJsonResponse({ error: "rate limited" }, false, 429));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callSummaryProvider({ provider: "openai", model: "m", apiKey: "k" }, "p"),
    ).rejects.toThrow("Summary provider error: 429");
  });

  it("throws when the response carries no text content", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockJsonResponse({ choices: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callSummaryProvider({ provider: "openai", model: "m", apiKey: "k" }, "p"),
    ).rejects.toThrow("no text content");
  });
});

/* --------------------------- session.idle hook --------------------------- */

describe("session.idle auto-summarization hook", () => {
  it("stores extracted memories end-to-end when configured", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const messagesMock = vi.fn().mockResolvedValue(SAMPLE_TRANSCRIPT);
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        choices: [{ message: { content: JSON.stringify(SAMPLE_MEMORIES) } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, dbPath } = makeContext({
      autoSummarize: true,
      summaryProvider: {
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "test-key",
      },
      logSpy,
      messagesMock,
    });

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks.event as (arg: { event: { type: string; properties?: { sessionID?: string } } }) => Promise<void>
    )({ event: { type: "session.idle", properties: { sessionID: "sess-abc" } } });

    // The detached task should fetch the transcript and call the provider.
    await vi.waitFor(() => {
      const storedCalls = logSpy.mock.calls.filter((c) => {
        const body = (c[0] as { body?: { message?: string } })?.body;
        return body?.message?.includes("stored 4 auto-summarized memories");
      });
      expect(storedCalls.length).toBe(1);
    });
    expect(messagesMock).toHaveBeenCalledWith({ params: { id: "sess-abc" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Verify the memories landed in the store with the right types + tags.
    const verifyStore = new MemoryStore({
      storagePath: dbPath,
      projectId: deriveProjectId(ctx.directory),
      embeddingModel: null,
    });
    await verifyStore.init();
    const list = await verifyStore.list({ scope: "all", limit: 50 });
    await verifyStore.close();

    const byType = (t: string) => list.memories.filter((m) => m.type === t);
    expect(byType("user_preference")).toHaveLength(1);
    expect(byType("codebase_fact")).toHaveLength(1);
    expect(byType("lesson_learned")).toHaveLength(1);
    expect(byType("session_summary")).toHaveLength(1);
    expect(byType("lesson_learned")[0].content).toContain("linter");
    expect(
      byType("lesson_learned")[0].tags.some((t) => t.startsWith("auto-summarized")),
    ).toBe(true);
  });

  it("makes no LLM call when autoSummarize is false", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ choices: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx } = makeContext({ autoSummarize: false, logSpy });

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks.event as (arg: { event: { type: string; properties?: { sessionID?: string } } }) => Promise<void>
    )({ event: { type: "session.idle", properties: { sessionID: "sess-1" } } });

    const skipCalls = logSpy.mock.calls.filter((c) => {
      const body = (c[0] as { body?: { message?: string } })?.body;
      return body?.message?.includes("summarization skipped (no provider configured)");
    });
    expect(skipCalls.length).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes no LLM call when autoSummarize is true but no provider is configured", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ choices: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx } = makeContext({ autoSummarize: true, logSpy });

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks.event as (arg: { event: { type: string; properties?: { sessionID?: string } } }) => Promise<void>
    )({ event: { type: "session.idle", properties: { sessionID: "sess-1" } } });

    const skipCalls = logSpy.mock.calls.filter((c) => {
      const body = (c[0] as { body?: { message?: string } })?.body;
      return body?.message?.includes("summarization skipped (no provider configured)");
    });
    expect(skipCalls.length).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes no LLM call for a transcript with too few messages", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const messagesMock = vi
      .fn()
      .mockResolvedValue([{ role: "user", content: "hi" }]);
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ choices: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx } = makeContext({
      autoSummarize: true,
      summaryProvider: { provider: "openai", model: "m", apiKey: "k" },
      logSpy,
      messagesMock,
    });

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks.event as (arg: { event: { type: string; properties?: { sessionID?: string } } }) => Promise<void>
    )({ event: { type: "session.idle", properties: { sessionID: "sess-1" } } });

    await vi.waitFor(() => {
      const skipCalls = logSpy.mock.calls.filter((c) => {
        const body = (c[0] as { body?: { message?: string } })?.body;
        return body?.message?.includes("no substantive transcript");
      });
      expect(skipCalls.length).toBe(1);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles a malformed LLM response without crashing (logged)", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const messagesMock = vi.fn().mockResolvedValue(SAMPLE_TRANSCRIPT);
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ choices: [{ message: { content: "total garbage" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { ctx } = makeContext({
      autoSummarize: true,
      summaryProvider: { provider: "openai", model: "m", apiKey: "k" },
      logSpy,
      messagesMock,
    });

    const hooks = await realmemoryPlugin(ctx);
    await expect(
      (
        hooks.event as (arg: { event: { type: string; properties?: { sessionID?: string } } }) => Promise<void>
      )({ event: { type: "session.idle", properties: { sessionID: "sess-1" } } }),
    ).resolves.toBeUndefined();

    await vi.waitFor(() => {
      const noMemCalls = logSpy.mock.calls.filter((c) => {
        const body = (c[0] as { body?: { message?: string } })?.body;
        return body?.message?.includes("LLM returned no parseable memories");
      });
      expect(noMemCalls.length).toBe(1);
    });
    // No unhandled rejection — fetch was called exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs and continues when the provider call throws (HTTP error)", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const messagesMock = vi.fn().mockResolvedValue(SAMPLE_TRANSCRIPT);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockJsonResponse({ error: "boom" }, false, 500));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx } = makeContext({
      autoSummarize: true,
      summaryProvider: { provider: "openai", model: "m", apiKey: "k" },
      logSpy,
      messagesMock,
    });

    const hooks = await realmemoryPlugin(ctx);
    await expect(
      (
        hooks.event as (arg: { event: { type: string; properties?: { sessionID?: string } } }) => Promise<void>
      )({ event: { type: "session.idle", properties: { sessionID: "sess-1" } } }),
    ).resolves.toBeUndefined();

    await vi.waitFor(() => {
      const errCalls = logSpy.mock.calls.filter(
        (c) => (c[0] as { body?: { level?: string } })?.body?.level === "error",
      );
      const summarizeErrors = errCalls.filter((c) => {
        const body = (c[0] as { body?: { message?: string } })?.body;
        return body?.message?.includes("Session summarize failed");
      });
      expect(summarizeErrors.length).toBe(1);
    });
  });

  it("is non-blocking: the event handler returns before the slow LLM call", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const messagesMock = vi.fn().mockResolvedValue(SAMPLE_TRANSCRIPT);
    const fetchMock = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return mockJsonResponse({ choices: [{ message: { content: "[]" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { ctx } = makeContext({
      autoSummarize: true,
      summaryProvider: { provider: "openai", model: "m", apiKey: "k" },
      logSpy,
      messagesMock,
    });

    const hooks = await realmemoryPlugin(ctx);
    const start = Date.now();
    await (
      hooks.event as (arg: { event: { type: string; properties?: { sessionID?: string } } }) => Promise<void>
    )({ event: { type: "session.idle", properties: { sessionID: "sess-1" } } });
    const elapsed = Date.now() - start;

    // The handler must resolve well before the 300ms fake LLM delay finishes.
    expect(elapsed).toBeLessThan(200);

    // The detached work still runs to completion afterwards.
    await vi.waitFor(() => {
      const noMemCalls = logSpy.mock.calls.filter((c) => {
        const body = (c[0] as { body?: { message?: string } })?.body;
        return body?.message?.includes("LLM returned no parseable memories");
      });
      expect(noMemCalls.length).toBe(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});