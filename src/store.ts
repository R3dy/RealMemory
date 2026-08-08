import type {
  Memory,
  StoreInput,
  RecallQuery,
  RecallResult,
  SearchQuery,
  SearchResult,
  UpdatePatch,
  ListQuery,
  ListResult,
  ForgetResult,
  Relationship,
  RelationshipType,
  MemoryWithRelations,
  MemoryStoreConfig,
} from "./types";
import { NotImplementedError } from "./errors";

export class MemoryStore {
  constructor(_config?: MemoryStoreConfig) {}

  async init(): Promise<void> {
    throw new NotImplementedError("init");
  }

  async store(_input: StoreInput): Promise<Memory> {
    throw new NotImplementedError("store");
  }

  async recall(_query: RecallQuery): Promise<RecallResult[]> {
    throw new NotImplementedError("recall");
  }

  async search(_query: SearchQuery): Promise<SearchResult> {
    throw new NotImplementedError("search");
  }

  async relate(
    _sourceId: string,
    _targetId: string,
    _type: RelationshipType,
  ): Promise<Relationship> {
    throw new NotImplementedError("relate");
  }

  async update(_id: string, _patch: UpdatePatch): Promise<Memory> {
    throw new NotImplementedError("update");
  }

  async forget(_id: string, _hard?: boolean): Promise<ForgetResult> {
    throw new NotImplementedError("forget");
  }

  async get(
    _id: string,
    _includeRelationships?: boolean,
  ): Promise<MemoryWithRelations> {
    throw new NotImplementedError("get");
  }

  async list(_query: ListQuery): Promise<ListResult> {
    throw new NotImplementedError("list");
  }

  async decay(): Promise<void> {
    throw new NotImplementedError("decay");
  }

  async close(): Promise<void> {
    throw new NotImplementedError("close");
  }
}
