import { defineConfig } from "tsup";
import { cpSync } from "node:fs";
import { join } from "node:path";

export default defineConfig({
  entry: ["src/index.ts", "src/mcp-server.ts", "src/bin.ts", "src/types.ts", "src/plugin-entry.ts", "src/traits.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  external: [
    "bun:sqlite",
    "better-sqlite3",
    "@huggingface/transformers",
    "@modelcontextprotocol/sdk",
  ],
  onSuccess: async () => {
    // Copy the vendored vis-network static assets into dist/browser/static/
    // so the published package ships the browser bundle (INV-014: it is a
    // static asset, never a Node `dependencies` entry).
    cpSync(
      join(process.cwd(), "src", "browser", "static"),
      join(process.cwd(), "dist", "browser", "static"),
      { recursive: true },
    );
  },
});
