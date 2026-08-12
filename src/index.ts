/** Semver version of the realmemory package. */
export const VERSION = "0.4.0";
export * from "./types";
export * from "./errors";
export { MemoryStore } from "./store";
export { loadConfig, validateConfig } from "./config";
export { deriveProjectId } from "./project-id";
export { computeWeight, computeRecencyFactor, computeFrequencyFactor } from "./weighting";
export { RecallEngine } from "./recall";
export { createEmbeddingProvider } from "./embeddings";
export type { EmbeddingProvider } from "./embeddings";
export { cosineSimilarity, embeddingFromBuffer, embeddingToBuffer } from "./similarity";
export { createMcpTools, startMcpServer } from "./mcp-server";
export type { McpToolHandler } from "./mcp-server";
export { scrubSecrets } from "./scrub";
export { classifyIntent, isHighSignal, dynamicLimit, evaluateDelta } from "./brain-loop";
export type { Intent, ToolCapture, BrainLoopState } from "./brain-loop";
export { default as realmemoryPlugin } from "./plugin";
export type { OpenCodePluginContext } from "./plugin";
