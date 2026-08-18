import {
  createMcpTools,
  startMcpServer
} from "./chunk-7NCBX4FW.js";
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
  computeFrequencyFactor,
  computeRecencyFactor,
  computeWeight,
  createEmbeddingProvider,
  loadConfig,
  scrubSecrets,
  validateConfig
} from "./chunk-K6MQZMEO.js";
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

// src/index.ts
var VERSION = "0.6.0";
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
