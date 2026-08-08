export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

export class MemoryStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryStoreError";
  }
}

export class MemoryNotFoundError extends MemoryStoreError {
  constructor(id: string) {
    super(`Memory not found: ${id}`);
    this.name = "MemoryNotFoundError";
  }
}

export class InvalidTypeError extends MemoryStoreError {
  constructor(type: string) {
    super(`Invalid memory type: ${type}`);
    this.name = "InvalidTypeError";
  }
}

export class InvalidConfidenceError extends MemoryStoreError {
  constructor(value: number) {
    super(`Invalid confidence value: ${value}. Must be in [0, 1]`);
    this.name = "InvalidConfidenceError";
  }
}

export class DuplicateRelationshipError extends MemoryStoreError {
  constructor(sourceId: string, targetId: string, type: string) {
    super(
      `Duplicate relationship: ${sourceId} -> ${targetId} (${type}) already exists`,
    );
    this.name = "DuplicateRelationshipError";
  }
}

export class SelfRelationshipError extends MemoryStoreError {
  constructor(id: string) {
    super(`Cannot create relationship from a memory to itself: ${id}`);
    this.name = "SelfRelationshipError";
  }
}
