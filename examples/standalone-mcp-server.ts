/**
 * standalone-mcp-server.ts
 *
 * Starts the realmemory MCP server programmatically — the same server that
 * `npx realmemory-mcp` launches via the bin entry. Useful when you want to
 * embed the MCP server in another process or test harness instead of spawning
 * a child process.
 *
 * The server speaks MCP over stdio, so run this example and pipe an MCP
 * client to its stdin/stdout:
 *
 *   npx tsx examples/standalone-mcp-server.ts
 *
 * (The process blocks on stdio; Ctrl-C to exit.)
 */
import { startMcpServer } from "realmemory";

async function main(): Promise<void> {
  // No argument → loads config from the standard files
  // (~/.config/opencode/realmemory.json then .realmemory/config.json),
  // merged with defaults. Pass a MemoryStoreConfig object to override.
  await startMcpServer({
    storagePath: "./example-mcp.db",
    embeddingModel: null,
  });

  console.error("[realmemory] MCP server running on stdio. Press Ctrl-C to stop.");
}

main().catch((err) => {
  console.error("[realmemory] MCP server failed to start:", err);
  process.exit(1);
});
