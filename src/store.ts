import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
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
import type { DbConnection } from "./db/connection";
import { openDatabase } from "./db/dialect";
import { runMigrations } from "./db/schema";

const DEFAULT_STORAGE_PATH = resolve(
  homedir(),
  ".opencode",
  "realmemory",
  "data.db",
);

export class MemoryStore {
  private config: MemoryStoreConfig;
  private db: DbConnection | null = null;

  constructor(config?: MemoryStoreConfig) {
    this.config = config ?? {};
  }

  async init(): Promise<void> {
    const storagePath = resolve(
      this.config.storagePath ?? DEFAULT_STORAGE_PATH,
    );
    const dir = dirname(storagePath);
    mkdirSync(dir, { recursive: true });

    const db = await openDatabase(storagePath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    runMigrations(db);
    this.db = db;
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
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
