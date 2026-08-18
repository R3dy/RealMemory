import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Vite config for the realmemory 3D Brain UI.
// Builds to ../src/browser/static/ui/ so tsup's onSuccess hook copies it
// into dist/browser/static/ui/ (vendored browser-side static asset, per ADR-006 #4).
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../src/browser/static/ui",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
