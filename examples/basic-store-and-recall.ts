/**
 * basic-store-and-recall.ts
 *
 * The simplest realmemory flow: create a store, store one memory, recall it
 * by natural-language query, then close the store.
 *
 * Run:  npx tsx examples/basic-store-and-recall.ts
 */
import { MemoryStore } from "realmemory";

async function main(): Promise<void> {
  // keyword-only mode (embeddingModel: null) keeps the example fast and
  // avoids downloading an ONNX model on first run. Set embeddingModel to
  // "Xenova/all-MiniLM-L6-v2" (the default) to enable semantic recall.
  const store = new MemoryStore({
    storagePath: "./example-data.db",
    embeddingModel: null,
  });
  await store.init();

  // Store a durable user preference.
  await store.store({
    content: "The user prefers tabs over spaces",
    type: "user_preference",
    scope: "global",
    confidence: 0.9,
    tags: ["formatting"],
  });

  // Recall by a natural-language query. The store scores every active
  // memory against the query and returns the top matches with related
  // memories (one-hop traversal) attached.
  const results = await store.recall({ query: "code formatting preferences" });
  console.log("Recalled:");
  for (const r of results) {
    console.log(`  [${r.matchedBy} score=${r.score.toFixed(2)}] ${r.memory.content}`);
  }

  await store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
