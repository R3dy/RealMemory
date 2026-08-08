/**
 * custom-config.ts
 *
 * Shows how to override every default by passing a MemoryStoreConfig directly
 * to the constructor (config files are skipped entirely when a config object
 * is provided). Covers decay half-life, embedding model, recall threshold, and
 * archive threshold.
 *
 * Run:  npx tsx examples/custom-config.ts
 */
import { MemoryStore } from "realmemory";

async function main(): Promise<void> {
  const store = new MemoryStore({
    // Use a per-example database so we don't touch the default one.
    storagePath: "./example-custom.db",

    // Keyword-only mode for a fast, offline example.
    // Set this to "Xenova/all-MiniLM-L6-v2" (or any local ONNX model) to
    // enable semantic vector recall, or set embeddingApiUrl + embeddingApiKey
    // to use a remote OpenAI-compatible /embeddings endpoint.
    embeddingModel: null,

    // Decay half-life: 7 days instead of the default 30. A memory a week old
    // has recencyFactor ≈ 0.368; two weeks old ≈ 0.135.
    decayHalfLifeDays: 7,

    // Only return memories scoring above 0.5 (stricter than the default 0.3).
    recallThreshold: 0.5,

    // Return up to 10 results per recall (default 5).
    maxRecallResults: 10,

    // Archive memories whose weight drops below 0.02 (default 0.05).
    archiveThreshold: 0.02,

    // Surface up to 5 related memories per result (default 3).
    maxRelatedPerMemory: 5,

    // Auto-capture from tool runs (the plugin sets this; the library leaves
    // it on by default for consistency).
    autoCapture: true,
  });
  await store.init();

  await store.store({
    content: "The deploy job runs every 15 minutes and is idempotent",
    type: "codebase_fact",
    scope: "global",
    confidence: 0.85,
    tags: ["deploy", "cron"],
  });

  const results = await store.recall({ query: "deploy schedule" });
  console.log(`Recalled ${results.length} memories with the custom config.`);

  // Run decay once to recompute weights and archive anything below the
  // custom archiveThreshold. In a long-lived app you'd call this on a timer.
  await store.decay();

  await store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
