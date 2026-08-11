import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import type { Server } from "node:http";
import { MemoryStore } from "../src/store";
import { startBrowserServer } from "../src/browser/server";
import { generateUlid } from "../src/db/ulid";

let tempDir: string;
let server: Server;
let port: number;
let store: MemoryStore;

function uniqueDbPath(): string {
  return join(tempDir, `test-${generateUlid()}.db`);
}

function request(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-ga-"));
  port = 30000 + Math.floor(Math.random() * 10000);
  store = new MemoryStore({ storagePath: uniqueDbPath(), projectId: "test-project", embeddingModel: null });
  await store.init();
  server = startBrowserServer(store, { port });
  await new Promise<void>((resolve) => server.once("listening", resolve));
});

afterEach(async () => {
  server.close();
  await store.close();
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("GET /api/graph", () => {
  it("returns nodes and edges for seeded data", async () => {
    const a = await store.store({ content: "first memory about AWS", type: "lesson_learned" });
    const b = await store.store({ content: "second memory about terraform", type: "codebase_fact" });
    await store.relate(a.id, b.id, "extends");

    const res = await request("/api/graph");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.nodes).toHaveLength(2);
    expect(data.edges).toHaveLength(1);
    expect(data.edges[0].source).toBe(a.id);
    expect(data.edges[0].target).toBe(b.id);
    expect(data.edges[0].type).toBe("extends");
  });

  it("filters by type", async () => {
    await store.store({ content: "a lesson", type: "lesson_learned" });
    await store.store({ content: "a fact", type: "codebase_fact" });

    const res = await request("/api/graph?type=lesson_learned");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].type).toBe("lesson_learned");
  });

  it("filters by scope", async () => {
    await store.store({ content: "project memory", type: "contextual_note", scope: "project" });
    await store.store({ content: "global memory", type: "contextual_note", scope: "global" });

    const res = await request("/api/graph?scope=global");
    const data = JSON.parse(res.body);
    expect(data.nodes.every((n: { scope: string }) => n.scope === "global")).toBe(true);
  });

  it("filters by minWeight", async () => {
    const low = await store.store({ content: "low weight item", type: "contextual_note" });
    // Reinforce the second one to boost its weight.
    const high = await store.store({ content: "high weight item", type: "contextual_note" });
    await store.update(high.id, { reinforce: true });

    const lowW = (await store.get(low.id, false)).memory.weight;
    const highW = (await store.get(high.id, false)).memory.weight;
    const threshold = (lowW + highW) / 2;

    const res = await request(`/api/graph?minWeight=${threshold}`);
    const data = JSON.parse(res.body);
    expect(data.nodes.every((n: { weight: number }) => n.weight >= threshold)).toBe(true);
  });

  it("text search via q returns matching nodes", async () => {
    await store.store({ content: "AWS S3 bucket policy", type: "codebase_fact" });
    await store.store({ content: "cooking recipe pasta", type: "contextual_note" });

    const res = await request("/api/graph?q=AWS%20S3");
    const data = JSON.parse(res.body);
    expect(data.nodes.length).toBe(1);
    expect(data.nodes[0].content).toContain("AWS");
  });

  it("returns empty nodes/edges for no matches", async () => {
    await store.store({ content: "something", type: "contextual_note" });
    const res = await request("/api/graph?q=nonexistenttermzzz");
    const data = JSON.parse(res.body);
    expect(data.nodes).toEqual([]);
    expect(data.edges).toEqual([]);
  });

  it("rejects limit > 2000 with 400", async () => {
    const res = await request("/api/graph?limit=2001");
    expect(res.status).toBe(400);
  });

  it("only returns edges between visible nodes", async () => {
    const a = await store.store({ content: "node a", type: "contextual_note" });
    const b = await store.store({ content: "node b", type: "contextual_note" });
    const c = await store.store({ content: "node c", type: "lesson_learned" });
    await store.relate(a.id, b.id, "reinforces");
    await store.relate(a.id, c.id, "extends");

    // Filter to only contextual_note — c is excluded, so the a->c edge should drop.
    const res = await request("/api/graph?type=contextual_note");
    const data = JSON.parse(res.body);
    expect(data.nodes).toHaveLength(2);
    expect(data.edges).toHaveLength(1);
    expect(data.edges[0].type).toBe("reinforces");
  });

  it("does not mutate the store during a full request sweep (read-only)", async () => {
    const a = await store.store({ content: "sweep test memory alpha", type: "lesson_learned" });
    const b = await store.store({ content: "sweep test memory beta", type: "codebase_fact" });
    await store.relate(a.id, b.id, "extends");

    // Snapshot state before the sweep.
    const beforeA = await store.get(a.id, false);
    const beforeB = await store.get(b.id, false);

    // Full request sweep — every read endpoint, with and without filters.
    await request("/api/graph");
    await request("/api/graph?type=lesson_learned");
    await request("/api/graph?q=sweep");
    await request("/api/graph?scope=all&minWeight=0");
    await request(`/api/memory/${a.id}`);
    await request(`/api/memory/${b.id}`);
    await request("/api/stats");

    // Re-read and assert nothing changed — no access_count bump, no weight change,
    // no updated_at change. This proves no UPDATE/INSERT/DELETE ran during the sweep.
    const afterA = await store.get(a.id, false);
    const afterB = await store.get(b.id, false);

    expect(afterA.memory.accessCount).toBe(beforeA.memory.accessCount);
    expect(afterB.memory.accessCount).toBe(beforeB.memory.accessCount);
    expect(afterA.memory.weight).toBe(beforeA.memory.weight);
    expect(afterB.memory.weight).toBe(beforeB.memory.weight);
    expect(afterA.memory.updatedAt).toBe(beforeA.memory.updatedAt);
    expect(afterB.memory.updatedAt).toBe(beforeB.memory.updatedAt);
  });

  it("filters by domain", async () => {
    await store.store({ content: "AWS lesson", type: "lesson_learned", domain: "aws" });
    await store.store({ content: "testing lesson", type: "lesson_learned", domain: "testing" });

    const res = await request("/api/graph?domain=aws");
    const data = JSON.parse(res.body);
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].domain).toBe("aws");
  });

  it("filters by category", async () => {
    await store.store({ content: "gotcha lesson", type: "lesson_learned", category: "gotcha" });
    await store.store({ content: "cost lesson", type: "lesson_learned", category: "cost" });

    const res = await request("/api/graph?category=gotcha");
    const data = JSON.parse(res.body);
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].category).toBe("gotcha");
  });
});

describe("GET /api/domains", () => {
  it("returns domain breakdown with counts", async () => {
    await store.store({ content: "aws 1", type: "lesson_learned", domain: "aws" });
    await store.store({ content: "aws 2", type: "codebase_fact", domain: "aws" });
    await store.store({ content: "test 1", type: "lesson_learned", domain: "testing" });

    const res = await request("/api/domains");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.total).toBe(3);
    const aws = data.domains.find((d: { name: string }) => d.name === "aws");
    expect(aws).toBeDefined();
    expect(aws.count).toBe(2);
    expect(aws.types.lesson_learned).toBe(1);
    expect(aws.types.codebase_fact).toBe(1);
  });
});

describe("GET /api/memory/:id", () => {
  it("returns the memory with its relationships", async () => {
    const a = await store.store({ content: "parent memory", type: "lesson_learned" });
    const b = await store.store({ content: "child memory", type: "codebase_fact" });
    await store.relate(a.id, b.id, "extends");

    const res = await request(`/api/memory/${a.id}`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.memory.id).toBe(a.id);
    expect(data.memory.content).toBe("parent memory");
    expect(data.relationships).toHaveLength(1);
    expect(data.relationships[0].type).toBe("extends");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request("/api/memory/nonexistent-id-xxx");
    expect(res.status).toBe(404);
  });
});
