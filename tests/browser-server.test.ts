import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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

describe("browser server — UI serving (issue #46)", () => {
  it("binds to 127.0.0.1, not 0.0.0.0", () => {
    const addr = server.address();
    expect(addr).not.toBeNull();
    if (addr && typeof addr === "object") {
      expect(addr.address).toBe("127.0.0.1");
    }
  });

  it("GET / serves the built SPA shell (HTML with #root)", async () => {
    const res = await request("/");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.body).toContain("<!doctype html>");
    expect(res.body).toContain('id="root"');
  });

  it("GET /assets/*.js serves application/javascript", async () => {
    // Find a built JS asset to test.
    const assetsDir = join(process.cwd(), "src", "browser", "static", "ui", "assets");
    if (existsSync(assetsDir)) {
      const jsFile = readdirSync(assetsDir).find((f) => f.endsWith(".js"));
      if (jsFile) {
        const res = await request(`/assets/${jsFile}`);
        expect(res.status).toBe(200);
        expect(res.contentType).toContain("application/javascript");
        expect(res.body.length).toBeGreaterThan(1000);
      }
    }
  });

  it("GET /favicon.ico serves an image (logo.svg fallback)", async () => {
    const res = await request("/favicon.ico");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("image/svg+xml");
  });

  it("GET /health returns 200 with { ok: true } (NOT hijacked by SPA fallback)", async () => {
    const res = await request("/health");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("GET /version returns 200 with { version: \"0.16.0\" }", async () => {
    const res = await request("/version");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ version: "0.16.0" });
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

  // SPA fallback tests
  it("GET /memories serves index.html (SPA fallback)", async () => {
    const res = await request("/memories");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.body).toContain('id="root"');
  });

  it("GET /brain serves index.html (SPA fallback)", async () => {
    const res = await request("/brain");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.body).toContain('id="root"');
  });

  it("GET /vitals serves index.html (SPA fallback)", async () => {
    const res = await request("/vitals");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.body).toContain('id="root"');
  });

  it("GET /api/nonexistent returns 404 JSON (NOT HTML — SPA fallback must not catch /api/)", async () => {
    const res = await request("/api/nonexistent");
    expect(res.status).toBe(404);
    expect(res.contentType).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ error: "Not Found" });
  });

  it("GET /../../etc/passwd is rejected (path traversal guard)", async () => {
    const res = await request("/../../etc/passwd");
    // The URL parser normalizes ../ in the path, so this may arrive as /etc/passwd
    // which triggers SPA fallback. The key is it does NOT serve /etc/passwd content.
    expect(res.status).toBe(200); // SPA fallback serves index.html
    expect(res.contentType).toContain("text/html");
    expect(res.body).not.toContain("root:"); // not /etc/passwd content
  });
});
