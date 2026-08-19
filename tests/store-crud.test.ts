import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";
import { scrubSecrets } from "../src/scrub";
import {
  InvalidTypeError,
  InvalidConfidenceError,
  MemoryNotFoundError,
  MemoryStoreError,
} from "../src/errors";
import type { Memory } from "../src/types";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `test-${generateUlid()}.db`);
}

async function freshStore(opts?: { projectId?: string | null }): Promise<MemoryStore> {
  const store = new MemoryStore({ storagePath: uniqueDbPath(), projectId: opts?.projectId });
  await store.init();
  return store;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("MemoryStore.store()", () => {
  it("stores a valid memory and returns it with all fields set", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    const mem = await store.store({
      content: "Always use tabs, not spaces.",
      type: "user_preference",
    });
    expect(mem.id).toHaveLength(26);
    expect(mem.content).toBe("Always use tabs, not spaces.");
    expect(mem.type).toBe("user_preference");
    expect(mem.scope).toBe("project");
    expect(mem.tags).toEqual([]);
    expect(mem.weight).toBeCloseTo(0.25, 5);
    expect(mem.confidence).toBe(0.5);
    expect(mem.accessCount).toBe(0);
    expect(mem.reinforcementCount).toBe(0);
    expect(mem.metadata).toEqual({});
    expect(mem.status).toBe("active");
    expect(mem.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mem.updatedAt).toBe(mem.createdAt);
    await store.close();
  });

  it("throws InvalidTypeError for an invalid type", async () => {
    const store = await freshStore();
    await expect(
      store.store({ content: "x", type: "bogus_type" as never }),
    ).rejects.toBeInstanceOf(InvalidTypeError);
    await store.close();
  });

  it("throws InvalidConfidenceError when confidence > 1", async () => {
    const store = await freshStore();
    await expect(
      store.store({ content: "x", type: "task_pattern", confidence: 1.5 }),
    ).rejects.toBeInstanceOf(InvalidConfidenceError);
    await store.close();
  });

  it("throws InvalidConfidenceError when confidence < 0", async () => {
    const store = await freshStore();
    await expect(
      store.store({ content: "x", type: "task_pattern", confidence: -0.2 }),
    ).rejects.toBeInstanceOf(InvalidConfidenceError);
    await store.close();
  });

  it("persists tags as JSON and returns them correctly", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "x",
      type: "lesson_learned",
      tags: ["aws", "terraform"],
    });
    expect(mem.tags).toEqual(["aws", "terraform"]);
    const fetched = await store.get(mem.id);
    expect(fetched.memory.tags).toEqual(["aws", "terraform"]);
    await store.close();
  });

  it("persists domain, category, and source fields", async () => {
    const store = await freshStore({ projectId: "project-a" });
    const mem = await store.store({
      content: "AWS rejects non-ASCII string params on every API.",
      type: "lesson_learned",
      domain: "aws",
      category: "gotcha",
      source: { project: "project-a", ref: "#114", refType: "issue" },
      tags: ["aws", "ascii"],
    });
    expect(mem.domain).toBe("aws");
    expect(mem.category).toBe("gotcha");
    expect(mem.source).toEqual({ project: "project-a", ref: "#114", refType: "issue" });
    const fetched = await store.get(mem.id, false);
    expect(fetched.memory.domain).toBe("aws");
    expect(fetched.memory.category).toBe("gotcha");
    expect(fetched.memory.source?.project).toBe("project-a");
    expect(fetched.memory.source?.ref).toBe("#114");
    await store.close();
  });

  it("defaults domain, category, source to null/empty when not provided", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "basic memory", type: "contextual_note" });
    expect(mem.domain).toBeUndefined();
    expect(mem.category).toBeUndefined();
    expect(mem.source).toEqual({});
    await store.close();
  });

  it("persists metadata as JSON and returns it correctly", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "x",
      type: "codebase_fact",
      metadata: { file: "src/index.ts", line: 42 },
    });
    expect(mem.metadata).toEqual({ file: "src/index.ts", line: 42 });
    const fetched = await store.get(mem.id);
    expect(fetched.memory.metadata).toEqual({ file: "src/index.ts", line: 42 });
    await store.close();
  });

  it("stores with scope 'global' → project_id is null", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    const mem = await store.store({
      content: "global fact",
      type: "contextual_note",
      scope: "global",
    });
    expect(mem.scope).toBe("global");
    // Listing with project scope should NOT see it.
    const projectScoped = await store.list({ scope: "project" });
    expect(projectScoped.memories.map((m) => m.id)).not.toContain(mem.id);
    const globalScoped = await store.list({ scope: "global" });
    expect(globalScoped.memories.map((m) => m.id)).toContain(mem.id);
    await store.close();
  });

  it("stores with scope 'project' → project_id is set", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    const mem = await store.store({
      content: "project fact",
      type: "contextual_note",
      scope: "project",
    });
    expect(mem.scope).toBe("project");
    const projectScoped = await store.list({ scope: "project" });
    expect(projectScoped.memories.map((m) => m.id)).toContain(mem.id);
    await store.close();
  });

  it("throws MemoryStoreError (RELATIONSHIP_NOT_FOUND) when relating to a non-existent target", async () => {
    const store = await freshStore();
    await expect(
      store.store({
        content: "x",
        type: "session_summary",
        relationships: [{ targetId: "NONEXISTENT00000000000000", type: "extends" }],
      }),
    ).rejects.toMatchObject({
      name: "MemoryStoreError",
      message: expect.stringContaining("RELATIONSHIP_NOT_FOUND"),
    });
    // The memory itself should NOT have been committed (transactional-ish: the row
    // exists but the relationship failure is thrown after insert — acceptable per spec,
    // but verify the error class is correct).
    await store.close();
  });

  it("scrubs AWS access keys from stored content", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "creds: AKIAIOSFODNN7EXAMPLE",
      type: "contextual_note",
    });
    expect(mem.content).toBe("creds: [REDACTED]");
    await store.close();
  });

  it("scrubs GitHub tokens from stored content", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "token: ghp_012345678901234567890123456789012345",
      type: "contextual_note",
    });
    expect(mem.content).toBe("token: [REDACTED]");
    await store.close();
  });

  it("leaves content with no secrets unchanged", async () => {
    const store = await freshStore();
    const content = "This is a perfectly innocent note about nothing sensitive.";
    const mem = await store.store({ content, type: "contextual_note" });
    expect(mem.content).toBe(content);
    await store.close();
  });
});

describe("MemoryStore.get()", () => {
  it("returns the memory with all fields by id", async () => {
    const store = await freshStore();
    const stored = await store.store({
      content: "hello",
      type: "lesson_learned",
      tags: ["a"],
      metadata: { k: "v" },
      confidence: 0.8,
    });
    const { memory } = await store.get(stored.id);
    expect(memory.id).toBe(stored.id);
    expect(memory.content).toBe("hello");
    expect(memory.tags).toEqual(["a"]);
    expect(memory.metadata).toEqual({ k: "v" });
    expect(memory.confidence).toBe(0.8);
    await store.close();
  });

  it("throws MemoryNotFoundError for a non-existent id", async () => {
    const store = await freshStore();
    await expect(store.get("NONEXISTENTID0000000000")).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
    await store.close();
  });

  it("returns relationships when includeRelationships=true", async () => {
    const store = await freshStore();
    const a = await store.store({ content: "A", type: "lesson_learned" });
    const b = await store.store({
      content: "B extends A",
      type: "lesson_learned",
      relationships: [{ targetId: a.id, type: "extends" }],
    });
    // B has an outgoing edge to A.
    const gotB = await store.get(b.id, true);
    expect(gotB.relationships).toHaveLength(1);
    expect(gotB.relationships[0].direction).toBe("outgoing");
    expect(gotB.relationships[0].type).toBe("extends");
    expect(gotB.relationships[0].memory.id).toBe(a.id);
    // A has an incoming edge from B.
    const gotA = await store.get(a.id, true);
    expect(gotA.relationships).toHaveLength(1);
    expect(gotA.relationships[0].direction).toBe("incoming");
    expect(gotA.relationships[0].memory.id).toBe(b.id);
    await store.close();
  });

  it("returns an empty relationships array when includeRelationships=false", async () => {
    const store = await freshStore();
    const a = await store.store({ content: "A", type: "lesson_learned" });
    await store.store({
      content: "B",
      type: "lesson_learned",
      relationships: [{ targetId: a.id, type: "extends" }],
    });
    const gotA = await store.get(a.id, false);
    expect(gotA.relationships).toEqual([]);
    await store.close();
  });
});

describe("MemoryStore.list()", () => {
  async function seed(store: MemoryStore): Promise<Memory[]> {
    return Promise.all([
      store.store({ content: "p1", type: "task_pattern", tags: ["x"], confidence: 0.9, scope: "project" }),
      store.store({ content: "p2", type: "lesson_learned", tags: ["y"], confidence: 0.5, scope: "project" }),
      store.store({ content: "g1", type: "task_pattern", tags: ["x"], confidence: 0.7, scope: "global" }),
    ]);
  }

  it("returns all active memories with no filters", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.list({});
    expect(res.memories).toHaveLength(3);
    expect(res.total).toBe(3);
    expect(res.offset).toBe(0);
    expect(res.limit).toBe(50);
    // Sorted by weight DESC.
    const weights = res.memories.map((m) => m.weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    await store.close();
  });

  it("filters by scope = project (only project-scoped)", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.list({ scope: "project" });
    expect(res.memories).toHaveLength(2);
    expect(res.memories.every((m) => m.scope === "project")).toBe(true);
    await store.close();
  });

  it("filters by scope = global (only global-scoped)", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.list({ scope: "global" });
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0].scope).toBe("global");
    await store.close();
  });

  it("filters by type", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.list({ type: "task_pattern" });
    expect(res.memories).toHaveLength(2);
    expect(res.memories.every((m) => m.type === "task_pattern")).toBe(true);
    await store.close();
  });

  it("filters by tag", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.list({ tag: "x" });
    expect(res.memories).toHaveLength(2);
    expect(res.memories.every((m) => m.tags.includes("x"))).toBe(true);
    await store.close();
  });

  it("filters by minWeight", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.list({ minWeight: 0.3 });
    expect(res.memories.every((m) => m.weight >= 0.3)).toBe(true);
    expect(res.memories).toHaveLength(2);
    await store.close();
  });

  it("paginates with limit + offset", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const page1 = await store.list({ limit: 2, offset: 0 });
    expect(page1.memories).toHaveLength(2);
    expect(page1.total).toBe(3);
    const page2 = await store.list({ limit: 2, offset: 2 });
    expect(page2.memories).toHaveLength(1);
    // No overlap between pages.
    const ids1 = page1.memories.map((m) => m.id);
    const ids2 = page2.memories.map((m) => m.id);
    expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
    await store.close();
  });
});

describe("MemoryStore.forget()", () => {
  it("soft-archives by default (status = 'archived')", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "x", type: "lesson_learned" });
    const result = await store.forget(mem.id);
    expect(result.archived).toBe(true);
    expect(result.id).toBe(mem.id);
    // get() now throws because the memory is archived (status != 'active').
    await expect(store.get(mem.id)).rejects.toBeInstanceOf(MemoryNotFoundError);
    // list() no longer returns it.
    const res = await store.list({});
    expect(res.memories.find((m) => m.id === mem.id)).toBeUndefined();
    await store.close();
  });

  it("hard-deletes when hard=true (removed from DB)", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "x", type: "lesson_learned" });
    const result = await store.forget(mem.id, true);
    expect(result.archived).toBe(false);
    await expect(store.get(mem.id)).rejects.toBeInstanceOf(MemoryNotFoundError);
    await store.close();
  });

  it("soft forget on an already-archived memory is a no-op", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "x", type: "lesson_learned" });
    await store.forget(mem.id); // archive
    const result = await store.forget(mem.id); // no-op
    expect(result.archived).toBe(true);
    expect(result.relationshipsRemoved).toBe(0);
    await store.close();
  });

  it("removes relationships when forgetting (cascade default)", async () => {
    const store = await freshStore();
    const a = await store.store({ content: "A", type: "lesson_learned" });
    const b = await store.store({
      content: "B extends A",
      type: "lesson_learned",
      relationships: [{ targetId: a.id, type: "extends" }],
    });
    // Forgetting A should remove the relationship edge.
    const result = await store.forget(a.id);
    expect(result.relationshipsRemoved).toBe(1);
    // B should now have no relationships (the incoming edge to A is gone).
    const gotB = await store.get(b.id, true);
    expect(gotB.relationships).toHaveLength(0);
    await store.close();
  });

  it("removes relationships on hard delete", async () => {
    const store = await freshStore();
    const a = await store.store({ content: "A", type: "lesson_learned" });
    const b = await store.store({
      content: "B extends A",
      type: "lesson_learned",
      relationships: [{ targetId: a.id, type: "extends" }],
    });
    const result = await store.forget(a.id, true);
    expect(result.relationshipsRemoved).toBe(1);
    expect(result.archived).toBe(false);
    const gotB = await store.get(b.id, true);
    expect(gotB.relationships).toHaveLength(0);
    await store.close();
  });

  it("throws MemoryNotFoundError when forgetting a non-existent id", async () => {
    const store = await freshStore();
    await expect(store.forget("NONEXISTENTID0000000000")).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
    await store.close();
  });
});

describe("scrubSecrets()", () => {
  it("redacts AWS access keys", () => {
    expect(scrubSecrets("key AKIAIOSFODNN7EXAMPLE here")).toBe("key [REDACTED] here");
  });

  it("redacts GitHub personal access tokens", () => {
    expect(
      scrubSecrets("ghp_012345678901234567890123456789012345"),
    ).toBe("[REDACTED]");
  });

  it("redacts GitHub OAuth tokens", () => {
    expect(
      scrubSecrets("gho_012345678901234567890123456789012345"),
    ).toBe("[REDACTED]");
  });

  it("redacts OpenAI API keys", () => {
    // sk- + exactly 48 alphanumeric chars.
    expect(
      scrubSecrets("sk-1234567890abcdefghijklmnopqrstuvwxyz0123456789AB"),
    ).toBe("[REDACTED]");
  });

  it("redacts PEM private keys", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    expect(scrubSecrets(pem)).toBe("[REDACTED]");
  });

  it("redacts generic key=value patterns", () => {
    // The value charclass is [a-zA-Z0-9_-]; trailing punctuation (the closing
    // quote) is NOT consumed by the pattern and remains after redaction.
    expect(
      scrubSecrets('api_key="abcdefghijklmnopqrstuvwxyz1234"'),
    ).toBe('[REDACTED]"');
  });

  it("leaves clean text unchanged", () => {
    expect(scrubSecrets("nothing to see here")).toBe("nothing to see here");
  });
});

describe("MemoryStore store with valid relationship", () => {
  it("stores a memory with a relationship to an existing target", async () => {
    const store = await freshStore();
    const a = await store.store({ content: "A", type: "lesson_learned" });
    const b = await store.store({
      content: "B",
      type: "lesson_learned",
      relationships: [{ targetId: a.id, type: "extends" }],
    });
    const gotB = await store.get(b.id, true);
    expect(gotB.relationships).toHaveLength(1);
    expect(gotB.relationships[0].memory.id).toBe(a.id);
    await store.close();
  });
});
