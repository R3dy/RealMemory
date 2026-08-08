import type { RecallQuery, RecallResult } from "./types";
import { MemoryStore } from "./store";
import { NotImplementedError } from "./errors";

export class RecallEngine {
  constructor(_store: MemoryStore) {}

  async recall(_query: RecallQuery): Promise<RecallResult[]> {
    throw new NotImplementedError("recall");
  }
}
