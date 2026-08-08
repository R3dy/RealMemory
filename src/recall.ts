import type { RecallQuery, RecallResult } from "./types";
import type { MemoryStore } from "./store";

/**
 * RecallEngine is a thin wrapper around MemoryStore.recall().
 *
 * It exists so callers can hold a dedicated recall-focused handle without
 * exposing the full store CRUD surface, and so future recall strategies
 * (re-ranking, cross-project federation, etc.) have a natural extension point.
 */
export class RecallEngine {
  constructor(private store: MemoryStore) {}

  /**
   * Delegate to {@link MemoryStore.recall}. Returns ranked results with
   * one-hop related memories attached.
   */
  async recall(query: RecallQuery): Promise<RecallResult[]> {
    return this.store.recall(query);
  }
}
