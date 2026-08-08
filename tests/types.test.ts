import { describe, it, expect } from "vitest";
import type {
  MemoryType,
  RelationshipType,
  MemoryScope,
  Memory,
  Relationship,
  StoreInput,
  RelationshipInput,
  RecallQuery,
  RecallResult,
  SearchQuery,
  SearchResult,
  UpdatePatch,
  ListQuery,
  ListResult,
  ForgetResult,
  RelationshipEdge,
  MemoryWithRelations,
  MemoryStoreConfig,
  SummaryProviderConfig,
} from "../src/index";

describe("public types", () => {
  it("compiles with all types in type positions", () => {
    const memoryType: MemoryType = "user_preference";
    const relationshipType: RelationshipType = "reinforces";
    const scope: MemoryScope = "project";

    const memory: Memory = {
      id: "m1",
      content: "hello",
      type: memoryType,
      scope,
      tags: ["a"],
      weight: 1,
      confidence: 0.9,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      accessCount: 0,
      reinforcementCount: 0,
      metadata: {},
      status: "active",
    };

    const relationship: Relationship = {
      id: "r1",
      sourceId: "m1",
      targetId: "m2",
      type: relationshipType,
      createdAt: "2026-01-01T00:00:00Z",
    };

    const relationshipInput: RelationshipInput = {
      targetId: "m2",
      type: relationshipType,
    };

    const storeInput: StoreInput = {
      content: "hello",
      type: memoryType,
      tags: ["a"],
      relationships: [relationshipInput],
    };

    const recallQuery: RecallQuery = { query: "hello", traverse: true };
    const recallResult: RecallResult = {
      memory,
      score: 0.95,
      matchedBy: "semantic",
      related: [],
    };

    const searchQuery: SearchQuery = {
      scope: "all",
      sortBy: "weight",
      sortOrder: "desc",
      limit: 10,
      offset: 0,
    };
    const searchResult: SearchResult = {
      memories: [memory],
      total: 1,
      offset: 0,
      limit: 10,
    };

    const updatePatch: UpdatePatch = { content: "updated", reinforce: true };

    const listQuery: ListQuery = { scope: "project", limit: 5, offset: 0 };
    const listResult: ListResult = {
      memories: [memory],
      total: 1,
      offset: 0,
      limit: 5,
    };

    const forgetResult: ForgetResult = {
      id: "m1",
      archived: true,
      relationshipsRemoved: 2,
    };

    const relationshipEdge: RelationshipEdge = {
      type: relationshipType,
      direction: "outgoing",
      memory,
    };

    const memoryWithRelations: MemoryWithRelations = {
      memory,
      relationships: [relationshipEdge],
    };

    const summaryProviderConfig: SummaryProviderConfig = {
      provider: "openai",
      model: "gpt-4",
    };

    const memoryStoreConfig: MemoryStoreConfig = {
      storagePath: "./.realmemory",
      decayHalfLifeDays: 30,
      recallThreshold: 0.7,
      maxRecallResults: 10,
      autoCapture: true,
      autoSummarize: true,
      summaryProvider: summaryProviderConfig,
      archiveThreshold: 0.1,
      maxRelatedPerMemory: 5,
    };

    expect(memory.id).toBe("m1");
    expect(relationship.id).toBe("r1");
    expect(storeInput.type).toBe(memoryType);
    expect(recallResult.score).toBe(0.95);
    expect(searchResult.total).toBe(1);
    expect(updatePatch.reinforce).toBe(true);
    expect(listResult.limit).toBe(5);
    expect(forgetResult.archived).toBe(true);
    expect(relationshipEdge.direction).toBe("outgoing");
    expect(memoryWithRelations.relationships.length).toBe(1);
    expect(memoryStoreConfig.summaryProvider?.provider).toBe("openai");
  });
});
