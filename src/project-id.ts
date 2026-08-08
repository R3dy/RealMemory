import { createHash } from "node:crypto";

/**
 * Derive a project identifier from the working directory.
 *
 * The plugin/hooks layer (Epic 7) will pass the actual project context —
 * ideally the git remote URL — but the library itself only needs a stable
 * hash from a path. Two different paths must produce different identifiers;
 * the same path must always produce the same identifier.
 *
 * @returns A 16-char hex string.
 */
export function deriveProjectId(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}
