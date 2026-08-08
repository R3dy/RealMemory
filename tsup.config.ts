import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/mcp-server.ts", "src/types.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  external: ["bun:sqlite", "better-sqlite3"],
});
