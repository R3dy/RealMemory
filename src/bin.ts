#!/usr/bin/env node
import { startMcpServer } from "./mcp-server";

startMcpServer().catch((err) => {
  console.error("[realmemory] MCP server failed to start:", err);
  process.exit(1);
});
