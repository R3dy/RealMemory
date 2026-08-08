/**
 * programmatic-api.ts
 *
 * A tour of the full CRUD lifecycle through the MemoryStore programmatic API:
 * store → get → list → search → update → relate → forget → decay → close.
 *
 * Run:  npx tsx examples/programmatic-api.ts
 */
import { MemoryStore } from "realmemory";

async function main(): Promise<void> {
  const store = new MemoryStore({
    storagePath: "./example-api.db",
    embeddingModel: null,
  });
  await store.init();

  // 1. STORE — create a memory. Returns the canonical Memory record.
  const pref = await store.store({
    content: "The user prefers tabs over spaces",
    type: "user_preference",
    scope: "global",
    confidence: 0.8,
    tags: ["formatting"],
  });
  console.log(`stored: ${pref.id} (weight ${pref.weight.toFixed(2)})`);

  // 2. GET — fetch by ID. Optionally include relationship edges.
  const fetched = await store.get(pref.id);
  console.log(`get: "${fetched.memory.content}" (${fetched.relationships.length} edges)`);

  // 3. STORE a second memory, then RELATE them.
  const lesson = await store.store({
    content: "Tabs render consistently across editors; spaces don't",
    type: "lesson_learned",
    scope: "global",
    confidence: 0.7,
    tags: ["formatting", "editors"],
  });
  await store.relate(lesson.id, pref.id, "reinforces");
  console.log("related: lesson reinforces preference (source confidence boosted)");

  // 4. LIST — paginated browse with simple filters.
  const page = await store.list({ scope: "all", limit: 10 });
  console.log(`list: ${page.total} memories total, page has ${page.memories.length}`);

  // 5. SEARCH — structured filters + sorting + pagination.
  const found = await store.search({
    tags: ["formatting"],
    sortBy: "weight",
    sortOrder: "desc",
    limit: 5,
  });
  console.log(`search by tag "formatting": ${found.total} matches`);

  // 6. UPDATE — patch content, tags, metadata; or reinforce (bumps
  //    reinforcementCount + confidence, recomputes weight).
  const reinforced = await store.update(pref.id, { reinforce: true });
  console.log(`update: reinforced → confidence ${reinforced.confidence.toFixed(2)}`);

  // 7. RECALL — hybrid semantic/keyword search with one-hop traversal.
  const recalled = await store.recall({ query: "indentation formatting", traverse: true });
  console.log(`recall: ${recalled.length} results, top score ${recalled[0]?.score.toFixed(2) ?? "n/a"}`);

  // 8. DECAY — recompute every memory's weight and archive anything below
  //    the archive threshold. Call on a timer in a long-lived app.
  await store.decay();

  // 9. FORGET — soft-archive (default) cascades relationships. Pass true for
  //    a hard delete.
  const forgot = await store.forget(lesson.id);
  console.log(`forget: archived=${forgot.archived}, removed ${forgot.relationshipsRemoved} edges`);

  // 10. CLOSE — releases the database handle.
  await store.close();
  console.log("done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
