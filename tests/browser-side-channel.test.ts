import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, get, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryStore } from "../src/store";
import * as browserServerModule from "../src/browser/server";
import { createMcpTools, startMcpServer } from "../src/mcp-server";

const SIDE_CHANNEL_PORT = 9333;
const CHILD_EXIT_TIMEOUT_MS = 3000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Step-0 pre-flight hermeticity guard (round-1 review 1-C4): assert
 * 127.0.0.1:9333 is not already bound before any test touches it. If it IS
 * bound, abort with a clear error instead of asserting against a foreign
 * process (a running realmemory/OpenCode instance).
 */
async function assertPort9333Free(): Promise<void> {
  const probe = createNetServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    probe.once("error", () =>
      rejectPromise(
        new Error(
          "port 9333 already in use — a realmemory/OpenCode instance is running; close it or run on a clean machine",
        ),
      ),
    );
    probe.listen(SIDE_CHANNEL_PORT, "127.0.0.1", () => {
      probe.close(() => resolvePromise());
    });
  });
}

function httpGet(
  port: number,
  path: string,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () =>
        resolvePromise({
          status: res.statusCode ?? 0,
          body,
          contentType: res.headers["content-type"] ?? "",
        }),
      );
    });
    req.on("error", rejectPromise);
  });
}

async function waitForHttpOk(
  port: number,
  path: string,
  timeoutMs = 10000,
): Promise<{ status: number; body: string; contentType: string }> {
  const start = Date.now();
  let lastErr: unknown = new Error(
    `timed out waiting for http://127.0.0.1:${port}${path}`,
  );
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await httpGet(port, path);
      if (res.status === 200) return res;
      lastErr = new Error(`unexpected status ${res.status} for ${path}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(75);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function expectConnRefused(port: number, path: string): Promise<void> {
  try {
    await httpGet(port, path);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ECONNREFUSED"
    ) {
      return;
    }
    throw err;
  }
  throw new Error(
    `expected ECONNREFUSED for http://127.0.0.1:${port}${path} but the server responded`,
  );
}

/** A newline-delimited reader over the child's stdout, with wait-for-line. */
interface LineReader {
  all(): string[];
  waitFor(predicate: (line: string) => boolean, timeoutMs: number): Promise<string>;
}

function makeLineReader(stream: NodeJS.ReadableStream): LineReader {
  const lines: string[] = [];
  let buf = "";
  const waiters: Array<{
    pred: (l: string) => boolean;
    resolve: (l: string) => void;
    reject: (e: Error) => void;
  }> = [];

  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      lines.push(line);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(line)) {
          const w = waiters.splice(i, 1)[0];
          w.resolve(line);
        }
      }
    }
  });

  return {
    all: () => [...lines],
    waitFor: (pred, timeoutMs) => {
      const existing = lines.find((l) => pred(l));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<string>((resolvePromise, rejectPromise) => {
        const w = { pred, resolve: resolvePromise, reject: rejectPromise };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            rejectPromise(new Error(`timeout waiting for line (${timeoutMs}ms)`));
          }
        }, timeoutMs);
      });
    },
  };
}

function sendMCP(child: ChildProcess, msg: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify(msg)}\n`);
}

async function waitForMCPResponse(
  reader: LineReader,
  id: number,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const line = await reader.waitFor((l) => {
    if (!l.trim()) return false;
    try {
      return (JSON.parse(l) as { id?: unknown }).id === id;
    } catch {
      return false;
    }
  }, timeoutMs);
  return JSON.parse(line) as Record<string, unknown>;
}

/** Drive the MCP initialize → notifications/initialized → tools/call store_memory flow. */
async function mcpInitializeAndStore(
  child: ChildProcess,
  reader: LineReader,
): Promise<string> {
  sendMCP(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "side-channel-test", version: "1.0.0" },
    },
  });
  const initRes = await waitForMCPResponse(reader, 1);
  if (initRes.error) {
    throw new Error(`initialize failed: ${JSON.stringify(initRes.error)}`);
  }
  sendMCP(child, { jsonrpc: "2.0", method: "notifications/initialized" });

  const callId = 2;
  sendMCP(child, {
    jsonrpc: "2.0",
    id: callId,
    method: "tools/call",
    params: {
      name: "store_memory",
      arguments: { content: "side channel experience memory", type: "contextual_note" },
    },
  });
  const callRes = await waitForMCPResponse(reader, callId);
  if (callRes.error) {
    throw new Error(`tools/call failed: ${JSON.stringify(callRes.error)}`);
  }
  const text = (callRes.result as { content: { type: string; text: string }[] }).content[0]
    .text;
  const memory = JSON.parse(text) as { id: string };
  return memory.id;
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`child did not exit in time (${timeoutMs}ms)`)),
      timeoutMs,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

/** Write the child's project config so loadConfig() sees a hermetic storage path. */
function writeChildConfig(dir: string, autoStartBrowser: boolean): void {
  const cfgDir = join(dir, ".realmemory");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify({
      storagePath: join(dir, "data.db"),
      projectId: "side-channel-test",
      embeddingModel: null,
      autoStartBrowser,
    }),
  );
}

/** Pre-populate a SQLite db at dir/data.db with two memories + one relationship. */
async function seedDb(dir: string): Promise<{ aId: string; bId: string }> {
  const readyStore = new MemoryStore({
    storagePath: join(dir, "data.db"),
    projectId: "side-channel-test",
    embeddingModel: null,
  });
  await readyStore.init();
  const a = await readyStore.store({
    content: "side channel seed: deploy kubernetes with gitops",
    type: "lesson_learned",
    scope: "global",
  });
  const b = await readyStore.store({
    content: "side channel seed: terraform state on s3",
    type: "codebase_fact",
    scope: "global",
  });
  await readyStore.relate(a.id, b.id, "extends");
  await readyStore.close();
  return { aId: a.id, bId: b.id };
}

/** Spawn the built MCP stdio server (`node dist/bin.js`) with a hermetic cwd. */
function spawnMcpBin(cwd: string): ChildProcess {
  return spawn(process.execPath, [resolve("dist/bin.js")], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: join(cwd, "fake-home"),
      USERPROFILE: join(cwd, "fake-home"),
    },
  });
}

describe("browser side channel (issue #12)", () => {
  let tempDir: string;
  let capturedBrowsers: Server[];
  let baselineSigint: NodeJS.SignalsListener[];
  let baselineSigterm: NodeJS.SignalsListener[];

  function snapshotSignalHandlers(): void {
    baselineSigint = process.listeners("SIGINT");
    baselineSigterm = process.listeners("SIGTERM");
  }

  function restoreSignalHandlers(): void {
    process.removeAllListeners("SIGINT");
    for (const l of baselineSigint) process.on("SIGINT", l);
    process.removeAllListeners("SIGTERM");
    for (const l of baselineSigterm) process.on("SIGTERM", l);
  }

  /** Wrap the module export so every started browser is captured for afterEach cleanup. */
  function captureBrowserServers(): void {
    const real = browserServerModule.startBrowserServer;
    vi.spyOn(browserServerModule, "startBrowserServer").mockImplementation(
      (store, opts) => {
        const srv = real(store, opts);
        capturedBrowsers.push(srv);
        return srv;
      },
    );
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "realmemory-sidechan-"));
    capturedBrowsers = [];
    snapshotSignalHandlers();
    captureBrowserServers();
  });

  afterEach(() => {
    for (const s of capturedBrowsers) {
      try {
        s.close();
      } catch {
        // best-effort
      }
    }
    capturedBrowsers = [];
    restoreSignalHandlers();
    vi.restoreAllMocks();
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("side channel: ownLifecycle:false → no SIGINT/SIGTERM handlers registered by the browser", async () => {
    const store = new MemoryStore({
      storagePath: join(tempDir, "o1.db"),
      projectId: "t",
      embeddingModel: null,
    });
    await store.init();
    const port = 31000 + Math.floor(Math.random() * 8000);
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");

    const srv = browserServerModule.startBrowserServer(store, {
      port,
      ownLifecycle: false,
    });
    await new Promise<void>((r) => srv.once("listening", () => r()));

    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);

    srv.close();
    await store.close();
  });

  it("side channel: ownLifecycle:false → store.close() is NOT called by the browser", async () => {
    const store = new MemoryStore({
      storagePath: join(tempDir, "o2.db"),
      projectId: "t",
      embeddingModel: null,
    });
    await store.init();
    const closeSpy = vi.spyOn(store, "close");
    const port = 31000 + Math.floor(Math.random() * 8000);

    const srv = browserServerModule.startBrowserServer(store, {
      port,
      ownLifecycle: false,
    });
    await new Promise<void>((r) => srv.once("listening", () => r()));

    // Simulate the MCP server closing the HTTP socket only.
    srv.close();
    await sleep(100);
    expect(closeSpy).not.toHaveBeenCalled();

    // The caller closes the shared store exactly once.
    await store.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("standalone --ui mode: ownLifecycle:true still installs handlers, closes store, and process.exit(0)s (regression)", async () => {
    const store = new MemoryStore({
      storagePath: join(tempDir, "ui.db"),
      projectId: "t",
      embeddingModel: null,
    });
    await store.init();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit(0) called");
    });
    const closeSpy = vi.spyOn(store, "close");
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");
    const port = 31000 + Math.floor(Math.random() * 8000);

    const srv = browserServerModule.startBrowserServer(store, { port }); // ownLifecycle defaults true
    await new Promise<void>((r) => srv.once("listening", () => r()));

    expect(process.listenerCount("SIGINT")).toBe(beforeSigint + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm + 1);

    const added = process.listeners("SIGINT").slice(beforeSigint);
    expect(added).toHaveLength(1);
    const shutdown = added[0] as () => void;
    expect(() => shutdown()).toThrow(/process\.exit/);
    expect(closeSpy).toHaveBeenCalled();

    srv.close();
    exitSpy.mockRestore();
  });

  it("side channel: startMcpServer() starts a browser on 127.0.0.1:9333 by default", async () => {
    await assertPort9333Free();
    const { aId, bId } = await seedDb(tempDir);

    // Explicit config keeps the test hermetic (no loadConfig file read —
    // round-1 review 1-C1). autoStartBrowser omitted → default-on.
    await startMcpServer({
      storagePath: join(tempDir, "data.db"),
      projectId: "side-channel-test",
      embeddingModel: null,
    });

    const home = await waitForHttpOk(SIDE_CHANNEL_PORT, "/");
    expect(home.contentType).toContain("text/html");
    expect(home.body).toContain("<html");
    expect(home.body).toContain("realmemory");

    const graphRes = await httpGet(SIDE_CHANNEL_PORT, "/api/graph");
    expect(graphRes.status).toBe(200);
    const graph = JSON.parse(graphRes.body) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ source: string; target: string }>;
    };
    const nodeIds = graph.nodes.map((n) => n.id);
    expect(nodeIds).toContain(aId);
    expect(nodeIds).toContain(bId);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
    expect(graph.edges.length).toBeGreaterThanOrEqual(1);
    expect(graph.edges.some((e) => e.source === aId && e.target === bId)).toBe(true);

    // Sanity: our capture infra (used by afterEach cleanup) saw the side channel.
    expect(capturedBrowsers.length).toBeGreaterThanOrEqual(1);
  });

  it("side channel: autoStartBrowser: false suppresses the browser; MCP tools still work", async () => {
    await assertPort9333Free();
    await seedDb(tempDir);

    await startMcpServer({
      storagePath: join(tempDir, "data.db"),
      projectId: "side-channel-test",
      embeddingModel: null,
      autoStartBrowser: false,
    });

    // Give a hypothetical listen the same window a real bind would need.
    await sleep(300);
    await expectConnRefused(SIDE_CHANNEL_PORT, "/");

    // MCP memory tools are unaffected by the suppression.
    const store = new MemoryStore({
      storagePath: join(tempDir, "tools.db"),
      projectId: "side-channel-test",
      embeddingModel: null,
    });
    await store.init();
    const tools = createMcpTools(store);
    const storer = tools.find((t) => t.name === "store_memory");
    expect(storer).toBeDefined();
    const result = (await storer?.handler({
      content: "suppress test memory",
      type: "contextual_note",
    })) as { id: string };
    expect(result.id).toHaveLength(26);
    await store.close();

    // No browser start was attempted at the call-site level.
    expect(capturedBrowsers).toHaveLength(0);
  });

  it("side channel: port collision → best-effort skip, MCP server still healthy", async () => {
    const occupant = createHttpServer();
    await new Promise<void>((r) => occupant.listen(SIDE_CHANNEL_PORT, "127.0.0.1", () => r()));
    try {
      await seedDb(tempDir);

      // The side channel attempts 9333 → EADDRINUSE → the browser's own
      // error handler swallows it; startMcpServer must resolve normally.
      await expect(
        startMcpServer({
          storagePath: join(tempDir, "data.db"),
          projectId: "side-channel-test",
          embeddingModel: null,
        }),
      ).resolves.toBeUndefined();
      await sleep(150);

      const store = new MemoryStore({
        storagePath: join(tempDir, "tools2.db"),
        projectId: "side-channel-test",
        embeddingModel: null,
      });
      await store.init();
      const tools = createMcpTools(store);
      const storer = tools.find((t) => t.name === "store_memory");
      const result = (await storer?.handler({
        content: "collision test memory",
        type: "contextual_note",
      })) as { id: string };
      expect(result.id).toHaveLength(26);
      await store.close();
    } finally {
      await new Promise<void>((r) => occupant.close(() => r()));
    }
  });

  it("side channel: browser writes nothing to stdout (stdout reserved for MCP JSON-RPC)", async () => {
    await assertPort9333Free();
    writeChildConfig(tempDir, true);
    await seedDb(tempDir);

    const child = spawnMcpBin(tempDir);
    const reader = makeLineReader(child.stdout!);
    try {
      await waitForHttpOk(SIDE_CHANNEL_PORT, "/");

      // Drive an MCP exchange so stdout actually carries JSON-RPC frames.
      sendMCP(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "side-channel-test", version: "1.0.0" },
        },
      });
      const initRes = await waitForMCPResponse(reader, 1);
      expect(initRes.jsonrpc).toBe("2.0");

      // Regression for §4.1: NO browser log lines on stdout — only JSON-RPC.
      const captured = reader.all();
      expect(captured.length).toBeGreaterThan(0);
      for (const line of captured) {
        expect(line.includes("UI server")).toBe(false);
        expect(line.includes("[realmemory]")).toBe(false);
        expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe("2.0");
      }
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await waitForExit(child, 5000).catch(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        });
      }
      child.stdin?.end();
    }
  });

  it("side channel: on SIGTERM the MCP child process exits 0 within 3s (round-1 review 1-C3)", async () => {
    await assertPort9333Free();
    writeChildConfig(tempDir, true);
    await seedDb(tempDir);

    const child = spawnMcpBin(tempDir);
    const reader = makeLineReader(child.stdout!);
    try {
      await waitForHttpOk(SIDE_CHANNEL_PORT, "/");

      const memId = await mcpInitializeAndStore(child, reader);
      expect(memId).toHaveLength(26);

      // The side channel and the MCP server share the same store — the write
      // is immediately visible to the browser.
      const graphRes = await httpGet(SIDE_CHANNEL_PORT, "/api/graph");
      const graph = JSON.parse(graphRes.body) as { nodes: unknown[] };
      expect(graph.nodes.length).toBe(3);

      // Deterministic shutdown: SIGTERM → close browser + store exactly once
      // → process.exit(0). The test FAILS on timeout — it must NOT SIGKILL
      // and then pass (no loophole).
      child.kill("SIGTERM");
      const result = await Promise.race([
        waitForExit(child, CHILD_EXIT_TIMEOUT_MS).then((r) => ({ kind: "exit" as const, ...r })),
        sleep(CHILD_EXIT_TIMEOUT_MS).then(() => ({ kind: "timeout" as const })),
      ]);
      if (result.kind === "timeout") {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        await waitForExit(child, 2000).catch(() => undefined);
        throw new Error("child did not exit within 3s of SIGTERM");
      }
      expect(result.signal).toBeNull();
      expect(result.code).toBe(0);
    } finally {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});