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

function uniqueDbPath(): string {
  return join(tempDir, `test-${generateUlid()}.db`);
}

async function freshStore(): Promise<MemoryStore> {
  const store = new MemoryStore({
    storagePath: uniqueDbPath(),
    projectId: "test-project",
    embeddingModel: null,
  });
  await store.init();
  return store;
}

/** Make a request to a running server and return {status, body, contentType}. */
function request(
  path: string,
  method = "GET",
  targetPort = port,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = get(
      { host: "127.0.0.1", port: targetPort, path, method, headers: { method } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body,
            contentType: res.headers["content-type"] ?? "",
          });
        });
      },
    );
    req.on("error", reject);
    if (method !== "GET") req.end();
  });
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-bm-"));
  port = 20000 + Math.floor(Math.random() * 10000);
  const store = await freshStore();
  // Seed some metrics so the endpoint has data to return.
  await store.recordMetric("recall_hit", 1.0);
  await store.recordMetric("recall_hit", 0.5);
  await store.recordMetric("duplicate_rate", 0.1);
  server = startBrowserServer(store, { port });
  // Wait for the server to be listening.
  await new Promise<void>((resolve) => server.once("listening", resolve));
});

afterEach(() => {
  server.close();
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("GET /api/metrics", () => {
  it("returns 200 with a JSON summary of all metrics", async () => {
    const res = await request("/api/metrics");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");

    const summary = JSON.parse(res.body) as Array<{
      metric_name: string;
      count: number;
      sum: number;
      avg: number;
      latest: number;
      latest_at: string;
    }>;
    expect(Array.isArray(summary)).toBe(true);
    const byName = new Map(summary.map((s) => [s.metric_name, s]));
    expect(byName.get("recall_hit")).toMatchObject({ count: 2, sum: 1.5 });
    expect(byName.get("duplicate_rate")).toMatchObject({ count: 1, sum: 0.1 });
    for (const s of summary) {
      expect(s.latest_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("supports the name query parameter", async () => {
    const res = await request("/api/metrics?name=recall_hit");
    expect(res.status).toBe(200);
    const summary = JSON.parse(res.body) as Array<{ metric_name: string }>;
    expect(summary).toHaveLength(1);
    expect(summary[0].metric_name).toBe("recall_hit");
  });

  it("supports the since query parameter", async () => {
    const res = await request("/api/metrics?since=2999-01-01T00:00:00.000Z");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns an empty array on a store with no metrics", async () => {
    // A fresh store (no metrics) on a different port.
    const tempDir2 = mkdtempSync(join(tmpdir(), "realmemory-bm-empty-"));
    const store2 = new MemoryStore({
      storagePath: join(tempDir2, "empty.db"),
      projectId: "test-project",
      embeddingModel: null,
    });
    await store2.init();
    const port2 = 30000 + Math.floor(Math.random() * 10000);
    const server2 = startBrowserServer(store2, { port: port2 });
    await new Promise<void>((resolve) => server2.once("listening", resolve));
    const res = await request("/api/metrics", "GET", port2);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
    server2.close();
    await store2.close();
    rmSync(tempDir2, { recursive: true, force: true });
  });

  it("returns 405 for non-GET methods (read-only preserved — INV-013)", async () => {
    const res = await request("/api/metrics", "POST");
    expect(res.status).toBe(405);
  });
});