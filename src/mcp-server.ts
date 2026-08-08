import type { MemoryStore } from "./store";
import { NotImplementedError } from "./errors";

export interface McpToolHandler {
  name: string;
  description: string;
  // The actual Zod schema will be added in Epic 6
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export function createMcpTools(_store: MemoryStore): McpToolHandler[] {
  const tools: McpToolHandler[] = [
    {
      name: "store_memory",
      description: "Store a new memory",
      handler: async () => {
        throw new NotImplementedError("store_memory");
      },
    },
    {
      name: "recall",
      description: "Semantic search for relevant memories",
      handler: async () => {
        throw new NotImplementedError("recall");
      },
    },
    {
      name: "search",
      description: "Structured search with filters",
      handler: async () => {
        throw new NotImplementedError("search");
      },
    },
    {
      name: "relate",
      description: "Create a typed relationship between two memories",
      handler: async () => {
        throw new NotImplementedError("relate");
      },
    },
    {
      name: "update_memory",
      description: "Update an existing memory",
      handler: async () => {
        throw new NotImplementedError("update_memory");
      },
    },
    {
      name: "forget",
      description: "Archive or delete a memory",
      handler: async () => {
        throw new NotImplementedError("forget");
      },
    },
    {
      name: "list_memories",
      description: "Browse memories with pagination",
      handler: async () => {
        throw new NotImplementedError("list_memories");
      },
    },
    {
      name: "get_memory",
      description: "Get a single memory by ID",
      handler: async () => {
        throw new NotImplementedError("get_memory");
      },
    },
  ];
  return tools;
}
