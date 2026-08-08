import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { deriveProjectId } from "../src/project-id";
import { generateUlid } from "../src/db/ulid";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `test-${generateUlid()}.db`);
}

async function freshStore(
  storagePath: string,
  projectId: string | null,
): Promise<MemoryStore> {
  const store = new MemoryStore({ storagePath, projectId });
  await store.init();
  return store;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-xproj-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("deriveProjectId()", () => {
  it("produces a 16-char hex string", () => {
    const id = deriveProjectId("/home/user/project-a");
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable for the same path", () => {
    expect(deriveProjectId("/home/user/project-a")).toBe(
      deriveProjectId("/home/user/project-a"),
    );
  });

  it("differs for different paths", () => {
    expect(deriveProjectId("/home/user/project-a")).not.toBe(
      deriveProjectId("/home/user/project-b"),
    );
  });
});

describe("cross-project scope handling", () => {
  it("stores a global memory with project_id null even when projectId is set", async () => {
    const store = await freshStore(uniqueDbPath(), "aaa");
    const mem = await store.store({
      content: "global note",
      type: "contextual_note",
      scope: "global",
    });
    expect(mem.scope).toBe("global");
    // scope=global must not appear in project-scoped list.
    const projectList = await store.list({ scope: "project" });
    expect(projectList.memories.map((m) => m.id)).not.toContain(mem.id);
    const globalList = await store.list({ scope: "global" });
    expect(globalList.memories.map((m) => m.id)).toContain(mem.id);
    await store.close();
  });

  it("stores a project memory with project_id set to config.projectId", async () => {
    const store = await freshStore(uniqueDbPath(), "aaa");
    const mem = await store.store({
      content: "project note",
      type: "contextual_note",
      scope: "project",
    });
    expect(mem.scope).toBe("project");
    const projectList = await store.list({ scope: "project" });
    expect(projectList.memories.map((m) => m.id)).toContain(mem.id);
    const globalList = await store.list({ scope: "global" });
    expect(globalList.memories.map((m) => m.id)).not.toContain(mem.id);
    await store.close();
  });

  it("isolates project A memories from project B when searching scope=project", async () => {
    const storagePath = uniqueDbPath();

    const storeA = await freshStore(storagePath, "aaa");
    const aProj = await storeA.store({
      content: "aaa project memory",
      type: "contextual_note",
      scope: "project",
    });
    const aGlobal = await storeA.store({
      content: "aaa global memory",
      type: "contextual_note",
      scope: "global",
    });
    await storeA.close();

    // Open the same DB file with a different project id.
    const storeB = await freshStore(storagePath, "bbb");
    const bProj = await storeB.store({
      content: "bbb project memory",
      type: "contextual_note",
      scope: "project",
    });

    // From B's perspective, scope=project must only see bbb memories.
    const bProject = await storeB.search({ scope: "project" });
    const bProjectIds = bProject.memories.map((m) => m.id);
    expect(bProjectIds).toContain(bProj.id);
    expect(bProjectIds).not.toContain(aProj.id);

    // From B's perspective, scope=global only sees the global memory.
    const bGlobal = await storeB.search({ scope: "global" });
    const bGlobalIds = bGlobal.memories.map((m) => m.id);
    expect(bGlobalIds).toContain(aGlobal.id);
    expect(bGlobalIds).not.toContain(aProj.id);
    expect(bGlobalIds).not.toContain(bProj.id);

    // scope=all from B sees bbb + global, but NOT aaa project memories.
    const bAll = await storeB.search({ scope: "all" });
    const bAllIds = bAll.memories.map((m) => m.id);
    expect(bAllIds).toContain(bProj.id);
    expect(bAllIds).toContain(aGlobal.id);
    expect(bAllIds).not.toContain(aProj.id);

    await storeB.close();

    // From A's perspective, scope=project must only see aaa memories.
    const storeA2 = await freshStore(storagePath, "aaa");
    const aProject = await storeA2.search({ scope: "project" });
    const aProjectIds = aProject.memories.map((m) => m.id);
    expect(aProjectIds).toContain(aProj.id);
    expect(aProjectIds).not.toContain(bProj.id);
    await storeA2.close();
  });

  it("search scope=global from project B sees global memory stored by project A", async () => {
    const storagePath = uniqueDbPath();

    const storeA = await freshStore(storagePath, "aaa");
    const globalMem = await storeA.store({
      content: "shared global fact",
      type: "codebase_fact",
      scope: "global",
    });
    await storeA.close();

    const storeB = await freshStore(storagePath, "bbb");
    const bGlobal = await storeB.search({ scope: "global" });
    expect(bGlobal.memories.map((m) => m.id)).toContain(globalMem.id);
    await storeB.close();
  });

  it("list() filters by scope=project / global / all consistently", async () => {
    const storagePath = uniqueDbPath();

    const storeA = await freshStore(storagePath, "aaa");
    const aProj = await storeA.store({
      content: "aaa project",
      type: "contextual_note",
      scope: "project",
    });
    const aGlobal = await storeA.store({
      content: "aaa global",
      type: "contextual_note",
      scope: "global",
    });
    await storeA.close();

    const storeB = await freshStore(storagePath, "bbb");
    const bProj = await storeB.store({
      content: "bbb project",
      type: "contextual_note",
      scope: "project",
    });

    // B project-scoped list: only bbb.
    const bProjectList = await storeB.list({ scope: "project" });
    const bProjectIds = bProjectList.memories.map((m) => m.id);
    expect(bProjectIds).toContain(bProj.id);
    expect(bProjectIds).not.toContain(aProj.id);

    // B global-scoped list: only global.
    const bGlobalList = await storeB.list({ scope: "global" });
    const bGlobalIds = bGlobalList.memories.map((m) => m.id);
    expect(bGlobalIds).toContain(aGlobal.id);
    expect(bGlobalIds).not.toContain(aProj.id);
    expect(bGlobalIds).not.toContain(bProj.id);

    // B all list: bbb + global, not aaa project.
    const bAllList = await storeB.list({ scope: "all" });
    const bAllIds = bAllList.memories.map((m) => m.id);
    expect(bAllIds).toContain(bProj.id);
    expect(bAllIds).toContain(aGlobal.id);
    expect(bAllIds).not.toContain(aProj.id);

    await storeB.close();
  });

  it("defaults to scope=all when scope is omitted", async () => {
    const storagePath = uniqueDbPath();

    const storeA = await freshStore(storagePath, "aaa");
    const aProj = await storeA.store({
      content: "aaa project",
      type: "contextual_note",
      scope: "project",
    });
    await storeA.store({
      content: "aaa global",
      type: "contextual_note",
      scope: "global",
    });
    await storeA.close();

    const storeB = await freshStore(storagePath, "bbb");
    await storeB.store({
      content: "bbb project",
      type: "contextual_note",
      scope: "project",
    });

    // No scope → "all": sees bbb + global, but NOT aaa project.
    const res = await storeB.list({});
    const ids = res.memories.map((m) => m.id);
    expect(ids).not.toContain(aProj.id);

    const searchRes = await storeB.search({});
    const searchIds = searchRes.memories.map((m) => m.id);
    expect(searchIds).not.toContain(aProj.id);

    await storeB.close();
  });

  it("a store with no projectId sees only global memories at scope=project", async () => {
    const storagePath = uniqueDbPath();

    const storeA = await freshStore(storagePath, "aaa");
    const aProj = await storeA.store({
      content: "aaa project",
      type: "contextual_note",
      scope: "project",
    });
    const aGlobal = await storeA.store({
      content: "aaa global",
      type: "contextual_note",
      scope: "global",
    });
    await storeA.close();

    // A store with no projectId: scope=project matches project_id IS NULL,
    // which is exactly the global memories.
    const storeGlobal = await freshStore(storagePath, null);
    const projectList = await storeGlobal.list({ scope: "project" });
    const projectIds = projectList.memories.map((m) => m.id);
    expect(projectIds).toContain(aGlobal.id);
    expect(projectIds).not.toContain(aProj.id);
    await storeGlobal.close();
  });
});
