import { MemoryStore } from "./store";
import { loadConfig } from "./config";
import { deriveProjectId } from "./project-id";
import type { MemoryStoreConfig, RecallResult, SummaryProviderConfig } from "./types";

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
  initialized: boolean;
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

export default async function realmemoryPlugin(
  ctx: OpenCodePluginContext,
): Promise<Record<string, unknown>> {
  const state: PluginState = {
    store: null,
    config: null,
    injectedMemoryIds: new Set(),
    initialized: false,
  };

  async function getStore(): Promise<MemoryStore> {
    if (!state.initialized) {
      state.config = {
        ...loadConfig(ctx.directory),
        projectId: deriveProjectId(ctx.directory),
      };
      state.store = new MemoryStore(state.config);
      await state.store.init();
      state.initialized = true;
    }
    return state.store!;
  }

  async function log(level: string, message: string, extra?: unknown): Promise<void> {
    const client = ctx.client as {
      app?: { log?: (args: unknown) => Promise<void> };
    };
    if (client?.app?.log) {
      await client.app.log({ body: { service: "realmemory", level, message, extra } });
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
          // Mark these as injected so we don't re-inject them later.
          results.forEach((r) => state.injectedMemoryIds.add(r.memory.id));
          if (results.length > 0) {
            await log("info", `Auto-recalled ${results.length} memories for new session`);
          }
        } catch (error) {
          await log(
            "error",
            `Auto-recall failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (event.type === "session.idle") {
        try {
          const store = await getStore();
          const config = state.config as {
            autoSummarize?: boolean;
            summaryProvider?: SummaryProviderConfig;
          };
          if (!config.autoSummarize || !config.summaryProvider) {
            // Skip if summarization is disabled or no provider configured.
            await log("info", "Session idle — summarization skipped (no provider configured)");
            return;
          }
          // Session summary generation requires an AI provider.
          // For MVP, we skip the actual LLM summarization and just log.
          // Reference store to keep TS happy about unused var in no-provider path.
          void store;
          await log("info", "Session idle — summarization not yet implemented");
        } catch (error) {
          await log(
            "error",
            `Session summarize failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },

    // On tool execution: auto-capture learnings (if enabled, default true).
    "tool.execute.after": async (
      input: { tool: string },
      output: { args?: Record<string, unknown>; output?: unknown },
    ) => {
      try {
        const store = await getStore();
        const config = state.config as { autoCapture?: boolean };
        if (config.autoCapture === false) return;

        // Read tool on config/schema/route files -> codebase_fact.
        if (input.tool === "read") {
          const filePath =
            (output.args as { filePath?: string } | undefined)?.filePath || "";
          if (isConfigOrSchemaFile(filePath)) {
            await store.store({
              content: `Read ${filePath}`,
              type: "codebase_fact",
              scope: "project",
              confidence: 0.3,
              tags: ["auto-captured", "file-read"],
              metadata: { source: "tool.execute.after", tool: "read", filePath },
            });
            await log("debug", `Auto-captured codebase_fact for ${filePath}`);
          }
        }

        // Bash tool on errors -> lesson_learned.
        if (input.tool === "bash") {
          const command =
            (output.args as { command?: string } | undefined)?.command || "";
          const result = String(output.output || "");
          if (isErrorResult(result)) {
            await store.store({
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
            await log("debug", "Auto-captured lesson_learned from bash error");
          }
        }
        // Write/Edit -> no capture (too noisy).
      } catch (error) {
        await log(
          "error",
          `Auto-capture failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    // On user message: auto-recall if the message matches stored memories.
    "message.updated": async (
      input: { message?: { role?: string; content?: string } },
      _output: unknown,
    ) => {
      try {
        const content = input?.message?.content;
        const role = input?.message?.role;
        if (role !== "human" || !content) return;

        const store = await getStore();
        const config = state.config as {
          recallThreshold?: number;
          maxRecallResults?: number;
        };
        const results = await store.recall({
          query: content,
          scope: "all",
          limit: 3,
          threshold: config.recallThreshold || 0.3,
          traverse: true,
        });

        // Deduplicate: skip memories already injected this session.
        const newResults = results.filter(
          (r) => !state.injectedMemoryIds.has(r.memory.id),
        );
        if (newResults.length === 0) return;

        newResults.forEach((r) => state.injectedMemoryIds.add(r.memory.id));
        const formatted = formatRecallResults(newResults);
        await log("info", `Auto-recalled ${newResults.length} memories for user message`);
        // The formatted text would be injected into the agent's context.
        // For MVP, we log it — the actual injection mechanism depends on the
        // OpenCode API (e.g. tui.prompt.append or a system message hook).
        void formatted;
      } catch (error) {
        await log(
          "error",
          `Message recall failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
