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

/** Make a GET request to the running server and return {status, headers, body}. */
function request(path: string, method = "GET"): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = get(
      { host: "127.0.0.1", port, path, method, headers: { method } },
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
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-bs-"));
  port = 20000 + Math.floor(Math.random() * 10000);
  const store = await freshStore();
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

describe("browser server", () => {
  it("binds to 127.0.0.1, not 0.0.0.0", () => {
    const addr = server.address();
    expect(addr).not.toBeNull();
    if (addr && typeof addr === "object") {
      expect(addr.address).toBe("127.0.0.1");
    }
  });

  it("GET / returns 200 text/html", async () => {
    const res = await request("/");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.body).toContain("<html");
    expect(res.body).toContain("realmemory");
  });

  it("GET /static/vis-network.min.js returns 200 application/javascript", async () => {
    const res = await request("/static/vis-network.min.js");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/javascript");
    expect(res.body.length).toBeGreaterThan(1000);
  });

  it("GET /favicon.ico returns 204", async () => {
    const res = await request("/favicon.ico");
    expect(res.status).toBe(204);
  });

  it("GET /health returns 200 with { ok: true }", async () => {
    const res = await request("/health");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("GET /api/stats returns 200 with the stats shape", async () => {
    const res = await request("/api/stats");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
    const stats = JSON.parse(res.body);
    expect(stats).toHaveProperty("totalMemories");
    expect(stats).toHaveProperty("byType");
    expect(stats).toHaveProperty("byScope");
    expect(stats).toHaveProperty("totalRelationships");
  });

  it("returns 405 for non-GET methods", async () => {
    const res = await request("/api/stats", "POST");
    expect(res.status).toBe(405);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await request("/unknown-path");
    expect(res.status).toBe(404);
  });
});
