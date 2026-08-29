import {
  VERSION,
  createMcpTools,
  startMcpServer
} from "./chunk-TKY4VEZD.js";
import {
  classifyIntent,
  deriveProjectId,
  dynamicLimit,
  evaluateDelta,
  isHighSignal
} from "./chunk-ZV65OZDS.js";
import {
  DuplicateRelationshipError,
  InvalidConfidenceError,
  InvalidTypeError,
  MemoryNotFoundError,
  MemoryStore,
  MemoryStoreError,
  NotImplementedError,
  SelfRelationshipError,
  createEmbeddingProvider,
  loadConfig,
  scrubSecrets,
  validateConfig
} from "./chunk-5VKJEIRO.js";
import {
  computeFrequencyFactor,
  computeRecencyFactor,
  computeWeight
} from "./chunk-KBPDWWWR.js";
import "./chunk-6F4PWJZI.js";
import {
  cosineSimilarity,
  embeddingFromBuffer,
  embeddingToBuffer
} from "./chunk-B5S5KXU7.js";

// src/recall.ts
var RecallEngine = class {
  constructor(store) {
    this.store = store;
  }
  store;
  /**
   * Delegate to {@link MemoryStore.recall}. Returns ranked results with
   * one-hop related memories attached.
   */
  async recall(query) {
    return this.store.recall(query);
  }
};
export {
  DuplicateRelationshipError,
  InvalidConfidenceError,
  InvalidTypeError,
  MemoryNotFoundError,
  MemoryStore,
  MemoryStoreError,
  NotImplementedError,
  RecallEngine,
  SelfRelationshipError,
  VERSION,
  classifyIntent,
  computeFrequencyFactor,
  computeRecencyFactor,
  computeWeight,
  cosineSimilarity,
  createEmbeddingProvider,
  createMcpTools,
  deriveProjectId,
  dynamicLimit,
  embeddingFromBuffer,
  embeddingToBuffer,
  evaluateDelta,
  isHighSignal,
  loadConfig,
  scrubSecrets,
  startMcpServer,
  validateConfig
};
