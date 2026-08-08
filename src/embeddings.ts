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

import type { MemoryStoreConfig } from "./types";

/** An embedding backend: embed text to a Float32 vector with a known dimensionality. */
export interface EmbeddingProvider {
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
export async function createEmbeddingProvider(
  config: MemoryStoreConfig,
): Promise<EmbeddingProvider | null> {
  if (config.embeddingApiUrl && config.embeddingApiKey) {
    return createRemoteProvider(config);
  }
  if (!config.embeddingModel) {
    return null;
  }
  try {
    return await createLocalProvider(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[realmemory] Failed to load local embedding model "${config.embeddingModel}": ${msg}. ` +
        `Falling back to keyword-only recall.`,
    );
    return null;
  }
}

/* ----------------------------- Local (ONNX) ----------------------------- */

const MINILM_DIMENSIONS = 384;

async function createLocalProvider(config: MemoryStoreConfig): Promise<EmbeddingProvider> {
  const { pipeline, env } = await import("@huggingface/transformers");

  // Cache downloaded models under the realmemory data directory when a
  // storagePath is configured, so we don't pollute a global cache.
  if (config.storagePath) {
    const { dirname } = await import("node:path");
    const { resolve } = await import("node:path");
    const { homedir } = await import("node:os");
    const raw = config.storagePath.startsWith("~")
      ? resolve(homedir(), config.storagePath.slice(1))
      : resolve(config.storagePath);
    env.cacheDir = dirname(raw);
  }

  const model = config.embeddingModel || "Xenova/all-MiniLM-L6-v2";
  const extractor = await pipeline("feature-extraction", model);

  return {
    model,
    dimensions: MINILM_DIMENSIONS,
    async embed(text: string): Promise<Float32Array> {
      const output = await extractor(text, { pooling: "mean", normalize: true });
      // Transformers.js returns a Tensor whose .data is a typed array.
      const data = output.data as ArrayLike<number>;
      return new Float32Array(data);
    },
  };
}

/* ----------------------------- Remote (HTTP) ---------------------------- */

function createRemoteProvider(config: MemoryStoreConfig): EmbeddingProvider {
  const apiUrl = config.embeddingApiUrl!;
  const apiKey = config.embeddingApiKey!;
  const model = config.embeddingModel || "text-embedding-3-small";

  // Dimensions is unknown until the first call returns; cache it lazily so
  // callers that read `.dimensions` before embedding get a sensible value.
  let cachedDims = 0;

  const embed = async (text: string): Promise<Float32Array> => {
    const url = apiUrl.endsWith("/") ? `${apiUrl}embeddings` : `${apiUrl}/embeddings`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: text }),
    });
    if (!response.ok) {
      throw new Error(
        `Embedding API error: ${response.status} ${response.statusText}`,
      );
    }
    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    const vec = data.data[0]?.embedding;
    if (!vec || vec.length === 0) {
      throw new Error("Embedding API returned empty vector");
    }
    if (cachedDims === 0) cachedDims = vec.length;
    return new Float32Array(vec);
  };

  return {
    model,
    get dimensions(): number {
      return cachedDims;
    },
    embed,
  };
}
