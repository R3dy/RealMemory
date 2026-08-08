/**
 * Cosine similarity and related vector utilities for the recall engine.
 */

/**
 * Compute the cosine similarity between two equal-length Float32 vectors.
 * Returns a value in [-1, 1]; for normalized embeddings it is in [0, 1].
 * Returns 0 when lengths differ or either vector is zero-length / zero-norm.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Deserialize a BLOB (Uint8Array / Buffer) stored in the `embedding` column
 * back into a Float32Array. Returns null when the blob is missing or empty.
 */
export function embeddingFromBuffer(buf: Uint8Array | null | undefined): Float32Array | null {
  if (!buf || buf.byteLength === 0) return null;
  if (buf.byteLength % 4 !== 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Serialize a Float32Array into a Node Buffer suitable for the BLOB column.
 */
export function embeddingToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
