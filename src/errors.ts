/** Thrown when a feature is referenced but not yet implemented. */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

/** Base error for all realmemory store failures. */
export class MemoryStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryStoreError";
  }
}

/** Thrown when a memory ID does not exist (or is not active). */
export class MemoryNotFoundError extends MemoryStoreError {
  constructor(id: string) {
    super(`Memory not found: ${id}`);
    this.name = "MemoryNotFoundError";
  }
}

/** Thrown when a store/update call uses an unrecognized MemoryType. */
export class InvalidTypeError extends MemoryStoreError {
  constructor(type: string) {
    super(`Invalid memory type: ${type}`);
    this.name = "InvalidTypeError";
  }
}

/** Thrown when confidence is outside [0, 1] or not a finite number. */
export class InvalidConfidenceError extends MemoryStoreError {
  constructor(value: number) {
    super(`Invalid confidence value: ${value}. Must be in [0, 1]`);
    this.name = "InvalidConfidenceError";
  }
}

/** Thrown when relating two memories that already share the same typed edge. */
export class DuplicateRelationshipError extends MemoryStoreError {
  constructor(sourceId: string, targetId: string, type: string) {
    super(
      `Duplicate relationship: ${sourceId} -> ${targetId} (${type}) already exists`,
    );
    this.name = "DuplicateRelationshipError";
  }
}

/** Thrown when attempting to relate a memory to itself. */
export class SelfRelationshipError extends MemoryStoreError {
  constructor(id: string) {
    super(`Cannot create relationship from a memory to itself: ${id}`);
    this.name = "SelfRelationshipError";
  }
}
