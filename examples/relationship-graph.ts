/**
 * relationship-graph.ts
 *
 * Demonstrates the typed relationship graph: store two memories, connect them
 * with a `reinforces` edge (which boosts the source's confidence), then recall
 * one and see the related memory surface via one-hop traversal.
 *
 * Run:  npx tsx examples/relationship-graph.ts
 */
import { MemoryStore } from "realmemory";

async function main(): Promise<void> {
  const store = new MemoryStore({
    storagePath: "./example-graph.db",
    embeddingModel: null,
  });
  await store.init();

  // 1. Store two related lessons.
  const lessonA = await store.store({
    content: "AWS create-image rejects non-ASCII characters in string params",
    type: "lesson_learned",
    scope: "global",
    confidence: 0.8,
    tags: ["aws", "create-image", "ascii"],
  });
  const lessonB = await store.store({
    content: "AWS CreateSecurityGroup also rejects non-ASCII in description fields",
    type: "lesson_learned",
    scope: "global",
    confidence: 0.7,
    tags: ["aws", "security-group", "ascii"],
  });

  // 2. Connect them: lessonB extends lessonA (both are the same AWS gotcha
  //    on different APIs). `extends` is structural — no confidence side effect.
  //    Try "reinforces" to see the source's confidence boost, or
  //    "contradicts" to see the target's confidence decay.
  await store.relate(lessonB.id, lessonA.id, "extends");

  // 3. Recall lessonA and inspect the related memory surfaced by traversal.
  const results = await store.recall({
    query: "AWS non-ASCII string params",
    traverse: true,
  });
  console.log("Recalled:");
  for (const r of results) {
    console.log(`  - ${r.memory.content}`);
    for (const rel of r.related) {
      console.log(`      related: ${rel.content}`);
    }
  }

  await store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
