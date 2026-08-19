#!/usr/bin/env node
// realmemory — history discovery script
//
// Mechanical extractor: scans opencode.db + the filesystem for every source of
// agent history on the machine, and emits a compact `history-catalog.json` that
// an agent then processes via the `realmemory-bootstrap` skill (recall → store/
// update/relate/forget).
//
// This script is deliberately DUMB and FAST: SQL + filesystem scan only. It does
// NO memory extraction, NO dedup, NO LLM calls. The cognitive work is the agent's
// job (the skill). Keeping them separate is what makes this runnable without
// burning agent context on exploration.
//
// Usage:
//   node scripts/discover-history.mjs                      # emit catalog to stdout
//   node scripts/discover-history.mjs --out catalog.json  # write to file
//   node scripts/discover-history.mjs --session <id>      # dump one session's full transcript
//   node scripts/discover-history.mjs --min-cost 0.5      # only sessions with cost >= 0.5
//   node scripts/discover-history.mjs --since 1720000000  # only sessions after unix ts
//   node scripts/discover-history.mjs --limit 500         # cap sessions in catalog
//   node scripts/discover-history.mjs --hub ~/my-projects
//   node scripts/discover-history.mjs --db ~/.local/share/opencode/opencode.db
//
// Requires: Node 18+ and EITHER better-sqlite3 (auto-detected from realmemory's
// deps) OR Node's built-in node:sqlite (Node 22.5+ with --experimental-sqlite,
// or Node 23.4+ unflagged). The script tries better-sqlite3 first, then
// node:sqlite, then exits with a helpful message if neither is available.

import { createRequire } from "node:module";
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { argv, stdout, stderr, env, exit, versions } from "node:process";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
const args = {};
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = argv[i + 1];
  if (next && !next.startsWith("--")) {
    args[key] = next;
    i++;
  } else {
    args[key] = "true";
  }
}

const home = homedir();
const HUB = args.hub || join(home, "projects");
const DB_PATH = args.db || join(home, ".local", "share", "opencode", "opencode.db");
const OUT = args.out || null;
const SESSION_ID = args.session || null;
const MIN_COST = args["min-cost"] ? parseFloat(args["min-cost"]) : 0;
const SINCE = args.since ? parseInt(args.since, 10) : 0;
const LIMIT = args.limit ? parseInt(args.limit, 10) : 0;
const VERBOSE = !!args.verbose;

function log(...a) {
  if (VERBOSE) stderr.write("[discover] " + a.join(" ") + "\n");
}

// ---------------------------------------------------------------------------
// sqlite loader — try better-sqlite3, then node:sqlite
// ---------------------------------------------------------------------------
function loadSqlite(dbPath) {
  // 1. better-sqlite3 (preferred — realmemory depends on it)
  try {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return { db, flavor: "better-sqlite3" };
  } catch (e) {
    log(`better-sqlite3 unavailable (${e.code || e.message}); trying node:sqlite`);
  }
  // 2. node:sqlite (Node 22.5+ flagged, 23.4+ unflagged)
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return { db, flavor: "node:sqlite" };
  } catch (e) {
    log(`node:sqlite unavailable (${e.message})`);
  }
  return null;
}

// tiny query adapter so both flavors share one call site
function all(db, flavor, sql, params = []) {
  if (flavor === "better-sqlite3") return db.prepare(sql).all(...params);
  // node:sqlite
  const stmt = db.prepare(sql);
  stmt.bind(...params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.all());
  stmt.finalize();
  return rows;
}

function get(db, flavor, sql, params = []) {
  const rows = all(db, flavor, sql, params);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// session transcript dump (--session <id>)
// ---------------------------------------------------------------------------
function dumpSession(db, flavor, sessionId) {
  const s = get(db, flavor, "SELECT id, title, project_id, directory, agent, model, time_created, cost, tokens_input, tokens_output FROM session WHERE id = ?", [sessionId]);
  if (!s) {
    stderr.write(`No session with id ${sessionId}\n`);
    exit(1);
  }
  const project = get(db, flavor, "SELECT name, worktree FROM project WHERE id = ?", [s.project_id]);
  const todos = all(db, flavor, "SELECT content, status, priority, position FROM todo WHERE session_id = ? ORDER BY position", [sessionId]);
  const messages = all(db, flavor, "SELECT id, time_created FROM message WHERE session_id = ? ORDER BY time_created", [sessionId]);
  const out = { session: { ...s, project }, todos };
  out.messages = messages.map((m) => {
    const parts = all(db, flavor, "SELECT data FROM part WHERE message_id = ? ORDER BY time_created", [m.id]);
    return { time: m.time_created, parts: parts.map((p) => safeParse(p.data)) };
  });
  return out;
}

function safeParse(s) {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

// ---------------------------------------------------------------------------
// catalog: opencode.db sessions
// ---------------------------------------------------------------------------
function catalogSessions(db, flavor) {
  const total = get(db, flavor, "SELECT COUNT(*) AS c FROM session")?.c || 0;
  const msgTotal = get(db, flavor, "SELECT COUNT(*) AS c FROM message")?.c || 0;
  const todoTotal = get(db, flavor, "SELECT COUNT(*) AS c FROM todo")?.c || 0;
  const range = get(db, flavor, "SELECT MIN(time_created) AS lo, MAX(time_created) AS hi FROM session") || {};
  const costTotal = get(db, flavor, "SELECT COALESCE(SUM(cost),0) AS c FROM session")?.c || 0;

  // ranked sessions: by cost desc, then todo count desc, then message count desc.
  // we pull a compact row per session (no part content — that's the --session dump).
  let sql = `
    SELECT s.id, s.title, s.directory, s.agent, s.model,
           s.time_created, s.cost, s.tokens_input, s.tokens_output,
           (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msg_count,
           (SELECT COUNT(*) FROM todo t WHERE t.session_id = s.id) AS todo_count
    FROM session s
    WHERE 1=1
  `;
  const params = [];
  if (MIN_COST > 0) {
    sql += ` AND s.cost >= ?`;
    params.push(MIN_COST);
  }
  if (SINCE > 0) {
    sql += ` AND s.time_created >= ?`;
    params.push(SINCE);
  }
  sql += ` ORDER BY s.cost DESC, todo_count DESC, msg_count DESC`;
  if (LIMIT > 0) {
    sql += ` LIMIT ?`;
    params.push(LIMIT);
  }
  const sessions = all(db, flavor, sql, params).map((r) => {
    // pull todos + first user message + last assistant snippet for each
    const todos = all(db, flavor, "SELECT content, status FROM todo WHERE session_id = ? ORDER BY position", [r.id]).map((t) => t.content);
    const firstMsg = get(db, flavor, "SELECT id FROM message WHERE session_id = ? ORDER BY time_created ASC LIMIT 1", [r.id]);
    let firstUser = "";
    if (firstMsg) {
      const p = get(db, flavor, "SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC LIMIT 1", [firstMsg.id]);
      if (p) firstUser = snippet(textOf(p.data), 300);
    }
    const lastMsg = get(db, flavor, "SELECT id FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 1", [r.id]);
    let lastAssistant = "";
    if (lastMsg) {
      const p = get(db, flavor, "SELECT data FROM part WHERE message_id = ? ORDER BY time_created DESC LIMIT 1", [lastMsg.id]);
      if (p) lastAssistant = snippet(textOf(p.data), 400);
    }
    return {
      id: r.id,
      title: r.title,
      directory: r.directory,
      agent: r.agent,
      model: r.model,
      timeCreated: r.time_created,
      cost: round(r.cost),
      tokens: { in: r.tokens_input, out: r.tokens_output },
      messageCount: r.msg_count,
      todoCount: r.todo_count,
      todos,
      firstUserMessage: firstUser,
      lastAssistantSnippet: lastAssistant,
    };
  });

  return {
    summary: {
      totalSessions: total,
      totalMessages: msgTotal,
      totalTodos: todoTotal,
      totalCost: round(costTotal),
      dateRange: [range.lo, range.hi],
      sessionsInCatalog: sessions.length,
    },
    sessions,
  };
}

function textOf(data) {
  if (typeof data !== "string") return "";
  try {
    const j = JSON.parse(data);
    if (typeof j === "string") return j;
    if (j && typeof j === "object") {
      return j.text || j.content || j.value || (typeof j.type === "string" ? `[${j.type}]` : "");
    }
    return String(j);
  } catch {
    return data;
  }
}

function snippet(s, n) {
  if (!s) return "";
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function round(n) {
  return typeof n === "number" ? Math.round(n * 10000) / 10000 : 0;
}

// ---------------------------------------------------------------------------
// filesystem scan: hub artifacts, agent defs, skills
// ---------------------------------------------------------------------------
function safeRead(p, maxLines = 0) {
  try {
    const txt = readFileSync(p, "utf8");
    const lines = txt.split("\n").length;
    return { path: p, exists: true, lines, snippet: maxLines ? txt.split("\n").slice(0, maxLines).join("\n") : undefined };
  } catch {
    return { path: p, exists: false };
  }
}

function listDir(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function scanFilesystem() {
  const sources = [];
  const projectArtifacts = [];
  const agentDefinitions = [];
  const skills = [];

  // MEMORY.md (hub root)
  sources.push({ kind: "memory.md", ...safeRead(join(HUB, "MEMORY.md")) });

  // AGENTS.md (hub root)
  sources.push({ kind: "agents.md", ...safeRead(join(HUB, "AGENTS.md")) });

  // PROJECTS/* — phase state, parking lot, project docs
  const projectsDir = join(HUB, "PROJECTS");
  for (const proj of listDir(projectsDir)) {
    const projPath = join(projectsDir, proj);
    if (!statSync(projPath).isDirectory()) continue;
    const art = { project: proj };
    const ps = safeRead(join(projPath, "PHASE_STATE.md"));
    if (ps.exists) {
      art.phaseState = ps;
      sources.push({ kind: "phase_state", project: proj, ...ps });
    }
    const pl = safeRead(join(projPath, "PARKING_LOT.md"));
    if (pl.exists) {
      art.parkingLot = pl;
      sources.push({ kind: "parking_lot", project: proj, ...pl });
    }
    const pm = safeRead(join(projPath, "PROJECT.md"));
    if (pm.exists) {
      art.projectMd = pm;
      sources.push({ kind: "project.md", project: proj, ...pm });
    }
    // ADRs at project docs level
    const adrDir = join(projPath, "docs", "adr");
    const adrFiles = listDir(adrDir).filter((f) => f.endsWith(".md"));
    if (adrFiles.length) {
      art.adrs = adrFiles.map((f) => ({ name: f, ...safeRead(join(adrDir, f)) }));
      for (const a of art.adrs) sources.push({ kind: "adr", project: proj, ...a });
    }
    // repo-level permanent agents
    const repoAgents = join(projPath, "repo", ".opencode", "agents");
    for (const f of listDir(repoAgents)) {
      if (!f.endsWith(".md")) continue;
      const a = { name: f.replace(/\.md$/, ""), location: "repo", ...safeRead(join(repoAgents, f)) };
      agentDefinitions.push(a);
      sources.push({ kind: "agent_definition", project: proj, ...a });
    }
    if (Object.keys(art).length > 1) projectArtifacts.push(art);
  }

  // ~/.config/opencode/agent/*.md — global agent definitions
  const ocAgents = join(home, ".config", "opencode", "agent");
  for (const f of listDir(ocAgents)) {
    if (!f.endsWith(".md")) continue;
    const a = { name: f.replace(/\.md$/, ""), location: "global-oc", ...safeRead(join(ocAgents, f)) };
    agentDefinitions.push(a);
    sources.push({ kind: "agent_definition", ...a });
  }

  // ~/.config/opencode/AGENTS.md
  const ocAgentsMd = safeRead(join(home, ".config", "opencode", "AGENTS.md"));
  if (ocAgentsMd.exists) sources.push({ kind: "opencode-agents.md", ...ocAgentsMd });

  // skills: ~/.config/opencode/skills, ~/.claude/skills, hub skills
  for (const skillsRoot of [
    join(home, ".config", "opencode", "skills"),
    join(home, ".claude", "skills"),
    join(HUB, "skills"),
  ]) {
    for (const entry of listDir(skillsRoot)) {
      const skillMd = join(skillsRoot, entry, "SKILL.md");
      if (existsSync(skillMd)) {
        const s = { name: entry, root: skillsRoot, ...safeRead(skillMd) };
        skills.push(s);
        sources.push({ kind: "skill", ...s });
      }
    }
  }

  // opencode.log tail (MCP connection events — useful for diagnosing dead MCP)
  try {
    const logPath = join(home, ".local", "share", "opencode", "log", "opencode.log");
    if (existsSync(logPath)) {
      const stat = statSync(logPath);
      sources.push({ kind: "opencode.log", path: logPath, exists: true, bytes: stat.size });
    }
  } catch {}

  return { sources, projectArtifacts, agentDefinitions, skills };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  if (!existsSync(DB_PATH)) {
    stderr.write(`opencode.db not found at ${DB_PATH}\nPass --db <path> or run on a machine with opencode history.\n`);
    exit(1);
  }

  const loaded = loadSqlite(DB_PATH);
  if (!loaded) {
    stderr.write(
      "No SQLite driver available. Install realmemory (npm i realmemory) for better-sqlite3, or use Node 22.5+ with --experimental-sqlite.\n",
    );
    exit(1);
  }
  const { db, flavor } = loaded;
  log(`using ${flavor}`);

  try {
    if (SESSION_ID) {
      const out = dumpSession(db, flavor, SESSION_ID);
      write(out);
      return;
    }

    const dbCatalog = catalogSessions(db, flavor);
    const fsCatalog = scanFilesystem();

    const catalog = {
      generatedAt: new Date().toISOString(),
      host: {
        node: versions.node,
        platform: platform(),
        hub: HUB,
        dbPath: DB_PATH,
        sqliteDriver: flavor,
      },
      dbSummary: dbCatalog.summary,
      sources: fsCatalog.sources,
      projectArtifacts: fsCatalog.projectArtifacts,
      agentDefinitions: fsCatalog.agentDefinitions,
      skills: fsCatalog.skills,
      sessions: dbCatalog.sessions,
      // guidance for the consuming agent (echoed in the skill too)
      nextSteps: [
        "Inventory existing memory: call realmemory list_memories (limit 100) to get the dedup baseline.",
        "Prioritize sessions by cost + todoCount + directory (project sessions > root).",
        "For each high-value session, dump its transcript: node scripts/discover-history.mjs --session <id>.",
        "For each candidate memory: recall first (semantic match), then store_memory / update_memory(reinforce) / relate / forget.",
        "Mine MEMORY.md (densest source — condensed lessons with Assumed/Reality/Lesson structure).",
        "Mine ADRs for decisions+rationale (codebase_fact).",
        "Mine agent definitions for user_preferences (how the user wants agents to behave).",
        "Relate: build the web (reinforces/contradicts/extends/derived_from).",
        "Forget: retire probe/test/stale memories that newer evidence contradicts.",
        "Report: N added/updated/reinforced/related/forgotten + gaps + contradictions for the user.",
      ],
    };
    write(catalog);
  } finally {
    try {
      db.close();
    } catch {}
  }
}

function write(obj) {
  const json = JSON.stringify(obj, null, 2);
  if (OUT) {
    import("node:fs").then(({ writeFileSync }) => {
      writeFileSync(OUT, json);
      stderr.write(`[discover] wrote ${OUT} (${json.length} bytes)\n`);
    });
  } else {
    stdout.write(json + "\n");
  }
}

main();
