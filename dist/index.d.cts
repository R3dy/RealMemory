import { MemoryStoreConfig, Memory, RecallQuery, RecallResult } from './types.cjs';
export { ForgetResult, ListQuery, ListResult, MemoryCategory, MemoryMetadata, MemoryScope, MemorySource, MemoryType, MemoryWithRelations, Relationship, RelationshipEdge, RelationshipInput, RelationshipType, SearchQuery, SearchResult, StoreInput, SummaryProviderConfig, UpdatePatch } from './types.cjs';
import { M as MemoryStore } from './store-C7A06i_s.cjs';
export { McpToolHandler, createMcpTools, startMcpServer } from './mcp-server.cjs';
import '@modelcontextprotocol/sdk/types.js';

/** Thrown when a feature is referenced but not yet implemented. */
declare class NotImplementedError extends Error {
    constructor(message: string);
}
/** Base error for all realmemory store failures. */
declare class MemoryStoreError extends Error {
    constructor(message: string);
}
/** Thrown when a memory ID does not exist (or is not active). */
declare class MemoryNotFoundError extends MemoryStoreError {
    constructor(id: string);
}
/** Thrown when a store/update call uses an unrecognized MemoryType. */
declare class InvalidTypeError extends MemoryStoreError {
    constructor(type: string);
}
/** Thrown when confidence is outside [0, 1] or not a finite number. */
declare class InvalidConfidenceError extends MemoryStoreError {
    constructor(value: number);
}
/** Thrown when relating two memories that already share the same typed edge. */
declare class DuplicateRelationshipError extends MemoryStoreError {
    constructor(sourceId: string, targetId: string, type: string);
}
/** Thrown when attempting to relate a memory to itself. */
declare class SelfRelationshipError extends MemoryStoreError {
    constructor(id: string);
}

/**
 * Load config from files, merged with defaults.
 *
 * Checks (in order, later overrides earlier):
 * 1. ~/.config/opencode/realmemory.json (global)
 * 2. .realmemory/config.json (project — relative to cwd or `projectDir`)
 *
 * Returns merged config with defaults applied. Missing files and invalid
 * JSON are silently ignored so a broken config never crashes the store.
 */
declare function loadConfig(projectDir?: string): MemoryStoreConfig;
/**
 * Validate a config object. Throws if any value is out of range.
 */
declare function validateConfig(config: MemoryStoreConfig): void;

/**
 * Derive a project identifier from the working directory.
 *
 * The plugin/hooks layer (Epic 7) will pass the actual project context —
 * ideally the git remote URL — but the library itself only needs a stable
 * hash from a path. Two different paths must produce different identifiers;
 * the same path must always produce the same identifier.
 *
 * @returns A 16-char hex string.
 */
declare function deriveProjectId(cwd: string): string;

/**
 * Compute the composite weight of a memory.
 * Weight = recencyFactor * relevanceFactor * frequencyFactor * confidenceFactor
 * Each factor is in [0, 1]. The product is also in [0, 1].
 *
 * Frequency uses a 0.5 baseline so a brand-new memory (0 accesses, 0 reinforcements)
 * gets frequencyFactor = 0.5, not 0 — ensuring fresh memories have non-zero weight.
 */
declare function computeWeight(memory: Pick<Memory, "createdAt" | "accessCount" | "reinforcementCount" | "confidence">, relevanceScore: number, config: {
    decayHalfLifeDays: number;
}): number;
/**
 * Recency factor using exponential decay.
 * recencyFactor = exp(-ageDays / halfLifeDays)
 * A 0-day-old memory → factor = 1.0
 * A memory aged halfLifeDays → factor = exp(-1) ≈ 0.368
 * A memory aged 2*halfLifeDays → factor = exp(-2) ≈ 0.135
 */
declare function computeRecencyFactor(createdAt: string, halfLifeDays: number): number;
/**
 * Frequency factor using logarithmic scaling (diminishing returns) with a 0.5 baseline.
 * frequencyFactor = 0.5 + 0.5 * (log(1 + accessCount + reinforcementCount) / log(1 + maxExpected))
 * A new memory (0,0) → 0.5 (baseline, not zero)
 * A memory accessed ~100 times → ~1.0
 */
declare function computeFrequencyFactor(accessCount: number, reinforcementCount: number): number;

/**
 * RecallEngine is a thin wrapper around MemoryStore.recall().
 *
 * It exists so callers can hold a dedicated recall-focused handle without
 * exposing the full store CRUD surface, and so future recall strategies
 * (re-ranking, cross-project federation, etc.) have a natural extension point.
 */
declare class RecallEngine {
    private store;
    constructor(store: MemoryStore);
    /**
     * Delegate to {@link MemoryStore.recall}. Returns ranked results with
     * one-hop related memories attached.
     */
    recall(query: RecallQuery): Promise<RecallResult[]>;
}

/**
 * Embedding providers for the recall engine.
 *
 * Two backends are supported, chosen by config:
 *   1. Remote — any OpenAI-compatible /embeddings endpoint (Bearer auth).
 *   2. Local  — @huggingface/transformers (ONNX) running in-process.
 *
 * When `embeddingModel` is empty/null the provider is null and the store
 * operates in keyword-only mode (FTS5 search, no vectors).
 */

/** An embedding backend: embed text to a Float32 vector with a known dimensionality. */
interface EmbeddingProvider {
    embed(text: string): Promise<Float32Array>;
    readonly dimensions: number;
    readonly model: string;
}
/**
 * Create an embedding provider based on config.
 * - If embeddingApiUrl + embeddingApiKey are set → use remote OpenAI-compatible API
 * - Otherwise, if embeddingModel is set → use local @huggingface/transformers (ONNX)
 * - If embeddingModel is null/empty → return null (keyword-only mode)
 *
 * Local provider creation is wrapped so that a failure to download/load the
 * model returns null instead of throwing — callers fall back to keyword-only.
 */
declare function createEmbeddingProvider(config: MemoryStoreConfig): Promise<EmbeddingProvider | null>;

/**
 * Cosine similarity and related vector utilities for the recall engine.
 */
/**
 * Compute the cosine similarity between two equal-length Float32 vectors.
 * Returns a value in [-1, 1]; for normalized embeddings it is in [0, 1].
 * Returns 0 when lengths differ or either vector is zero-length / zero-norm.
 */
declare function cosineSimilarity(a: Float32Array, b: Float32Array): number;
/**
 * Deserialize a BLOB (Uint8Array / Buffer) stored in the `embedding` column
 * back into a Float32Array. Returns null when the blob is missing or empty.
 */
declare function embeddingFromBuffer(buf: Uint8Array | null | undefined): Float32Array | null;
/**
 * Serialize a Float32Array into a Node Buffer suitable for the BLOB column.
 */
declare function embeddingToBuffer(vec: Float32Array): Buffer;

/**
 * Secret scrubbing — replaces common credential patterns with [REDACTED].
 *
 * A regex-based pass covering AWS, GitHub, OpenAI, Slack, Bearer tokens, PEM
 * private keys, and generic `password=` / `api_key=` assignments. Each match
 * (including the key name for generic assignments) is replaced wholesale with
 * `[REDACTED]` so the secret value is never persisted.
 */
/**
 * Replace known secret patterns in `content` with `[REDACTED]`.
 * Idempotent: a clean string is returned unchanged.
 */
declare function scrubSecrets(content: string): string;

/** Intent classification for a user turn. */
type Intent = "correction" | "repetition" | "preference" | "tool_outcome" | "generic";
/** Tool capture data passed from plugin.ts tool.execute.after to classifyIntent. */
interface ToolCapture {
    tool: string;
    filePath?: string;
    command?: string;
    isError: boolean;
    timestamp: number;
}
/**
 * PluginState subset that evaluateDelta reads. The real PluginState in plugin.ts
 * has more fields; this interface documents what evaluateDelta needs.
 */
interface BrainLoopState {
    lastUserText: string | null;
    lastUserIntent: Intent | null;
    lastToolCapture: ToolCapture | null;
    lastInjectedMemoryIds: string[] | null;
    config: {
        brainLoop?: boolean;
        autoRelate?: boolean;
        concisenessCap?: number;
    };
}
/**
 * Classify the intent of a user turn. Pure function — no side effects.
 *
 * Order: correction > preference > repetition > tool_outcome > generic.
 * - correction: userText matches a correction pattern.
 * - preference: userText matches a preference pattern.
 * - repetition: currentUserText (normalized) is already in recentUserTexts
 *   (classify-first-then-push: the buffer holds PRIOR messages, not current).
 * - tool_outcome: lastToolCapture is set AND no correction/preference/repetition matched.
 * - generic: none of the above.
 */
declare function classifyIntent(userText: string, _assistantText: string, recentUserTexts: string[], lastToolCapture: ToolCapture | null): Intent;
/** Whether an intent warrants storing a delta memory. */
declare function isHighSignal(intent: Intent): boolean;
/** Dynamic recall limit based on intent. Higher for correction/preference. */
declare function dynamicLimit(intent: Intent): number;
/**
 * Evaluate the per-turn delta. Runs on session.idle (PRIMARY, C1 fix) detached.
 * Does NOT clear lastToolCapture — the caller clears it AFTER this resolves (C2 fix).
 * No LLM call anywhere (local heuristics only — INV-017, avoids Drift #5).
 */
declare function evaluateDelta(store: MemoryStore, state: BrainLoopState, userText: string, assistantText: string): Promise<void>;

/** Semver version of the realmemory package. */
declare const VERSION = "0.6.0";

export { type BrainLoopState, DuplicateRelationshipError, type EmbeddingProvider, type Intent, InvalidConfidenceError, InvalidTypeError, Memory, MemoryNotFoundError, MemoryStore, MemoryStoreConfig, MemoryStoreError, NotImplementedError, RecallEngine, RecallQuery, RecallResult, SelfRelationshipError, type ToolCapture, VERSION, classifyIntent, computeFrequencyFactor, computeRecencyFactor, computeWeight, cosineSimilarity, createEmbeddingProvider, deriveProjectId, dynamicLimit, embeddingFromBuffer, embeddingToBuffer, evaluateDelta, isHighSignal, loadConfig, scrubSecrets, validateConfig };
