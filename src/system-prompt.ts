/**
 * Merge-append a block into an OpenCode system-prompt array (issue #64).
 *
 * The host serializes EACH element of `output.system` as a SEPARATE system
 * message in the LLM request. Pushing a new element therefore produces a
 * second (or third) system message — the `[system, system, user]` shape that
 * strict chat templates reject ("System message must be at the beginning").
 * This helper MERGES the block into the LAST existing element (joined with a
 * blank line) so the request keeps a single system message. A block is only
 * PUSHED when the array is empty (it then becomes the sole system message).
 *
 * Zero deps, synchronous, pure-RAM (INV-017 discipline — the transform hook
 * must never do I/O or await). Internal-only: NOT exported from `src/index.ts`
 * and NOT listed in `package.json` `exports` (issue #36 C16 discipline).
 */
export function appendToSystemLast(
  system: string[] | undefined,
  block: string,
): void {
  if (!Array.isArray(system)) return; // defensive: non-array -> no-op, never throws
  if (block === "") return; // nothing to deliver
  if (system.length === 0) {
    system.push(block); // empty array: the block becomes the sole system message
    return;
  }
  const last = system.length - 1;
  system[last] = system[last] + "\n\n" + block;
}
