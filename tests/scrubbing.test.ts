import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { scrubSecrets } from "../src/scrub";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `test-${generateUlid()}.db`);
}

async function freshStore(): Promise<MemoryStore> {
  const store = new MemoryStore({ storagePath: uniqueDbPath() });
  await store.init();
  return store;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-scrub-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Build secret-shaped strings programmatically so no real-format secret
// literal appears in source (GitHub secret scanning would block the push).
const SLACK_BOT = ["xoxb", "1234567890", "1234567890", "1234567890abcdef"].join("-");
const SLACK_USER = ["xoxp", "1234567890", "1234567890", "1234567890abcdef"].join("-");
const AWS_SECRET = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/");
const BEARER_VAL = ["dGhpc19", "pc19hX3", "Rva2Vu"].join("");

describe("scrubSecrets() — expanded patterns", () => {
  it("redacts AWS access keys (AKIA...)", () => {
    expect(scrubSecrets("key AKIAIOSFODNN7EXAMPLE here")).toBe(
      "key [REDACTED] here",
    );
  });

  it("redacts AWS secret access keys", () => {
    const content = "aws_secret_access_key=" + AWS_SECRET;
    expect(scrubSecrets(content)).toBe("[REDACTED]");
  });

  it("redacts GitHub personal access tokens (ghp_...)", () => {
    expect(scrubSecrets("ghp_012345678901234567890123456789012345")).toBe(
      "[REDACTED]",
    );
  });

  it("redacts GitHub OAuth tokens (gho_...)", () => {
    expect(scrubSecrets("gho_012345678901234567890123456789012345")).toBe(
      "[REDACTED]",
    );
  });

  it("redacts GitHub app tokens (ghs_...)", () => {
    const token = ["ghs", "012345678901234567890123456789012345"].join("_");
    expect(scrubSecrets(token)).toBe("[REDACTED]");
  });

  it("redacts GitHub refresh tokens (ghr_...)", () => {
    // ghr_ + 76 alphanumeric chars.
    const token = ["ghr", "0123456789".repeat(7) + "abcdef"].join("_");
    expect(token.length).toBe(4 + 76);
    expect(scrubSecrets(token)).toBe("[REDACTED]");
  });

  it("redacts OpenAI API keys (sk-...)", () => {
    expect(
      scrubSecrets("sk-1234567890abcdefghijklmnopqrstuvwxyz0123456789AB"),
    ).toBe("[REDACTED]");
  });

  it("redacts Slack tokens (xoxb-...)", () => {
    expect(scrubSecrets(SLACK_BOT)).toBe("[REDACTED]");
  });

  it("redacts Slack user tokens (xoxp-...)", () => {
    expect(scrubSecrets(SLACK_USER)).toBe("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    expect(scrubSecrets("Authorization: Bearer " + BEARER_VAL)).toBe(
      "Authorization: [REDACTED]",
    );
  });

  it("redacts PEM private keys (any key type)", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    expect(scrubSecrets(pem)).toBe("[REDACTED]");
  });

  it("redacts PEM EC private keys", () => {
    const pem =
      "-----BEGIN EC PRIVATE KEY-----\nMHQCAQEE...\n-----END EC PRIVATE KEY-----";
    expect(scrubSecrets(pem)).toBe("[REDACTED]");
  });

  it("redacts bare password assignments", () => {
    expect(scrubSecrets("password=mypassword123")).toBe("[REDACTED]");
  });

  it("redacts quoted password assignments", () => {
    expect(scrubSecrets('password="mypassword123"')).toBe('[REDACTED]"');
  });

  it("redacts pwd assignments", () => {
    expect(scrubSecrets("pwd=supersecret")).toBe("[REDACTED]");
  });

  it("redacts api_key assignments", () => {
    expect(scrubSecrets("api_key=sk_test_1234567890abcdef")).toBe("[REDACTED]");
  });

  it("redacts access_token assignments", () => {
    expect(scrubSecrets("access_token=abc123def456ghi789jkl012")).toBe(
      "[REDACTED]",
    );
  });

  it("redacts secret_key assignments", () => {
    expect(
      scrubSecrets("secret_key=abcdefghijklmnopqrstuvwxyz1234"),
    ).toBe("[REDACTED]");
  });

  it("redacts api-key (hyphenated) assignments", () => {
    expect(
      scrubSecrets("api-key=abcdefghijklmnopqrstuvwxyz1234"),
    ).toBe("[REDACTED]");
  });

  it("leaves content with no secrets unchanged", () => {
    const clean = "This is a perfectly innocent note about nothing sensitive.";
    expect(scrubSecrets(clean)).toBe(clean);
  });

  it("redacts multiple secrets in one string", () => {
    const content =
      "aws AKIAIOSFODNN7EXAMPLE and ghp_012345678901234567890123456789012345 plus sk-1234567890abcdefghijklmnopqrstuvwxyz0123456789AB";
    const scrubbed = scrubSecrets(content);
    expect(scrubbed).toBe("aws [REDACTED] and [REDACTED] plus [REDACTED]");
  });

  it("is idempotent (scrubbing an already-scrubbed string is a no-op)", () => {
    const once = scrubSecrets("key AKIAIOSFODNN7EXAMPLE");
    expect(scrubSecrets(once)).toBe(once);
  });
});

describe("store() / update() secret scrubbing (integration)", () => {
  it("store() scrubs AWS access keys before persisting", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "creds: AKIAIOSFODNN7EXAMPLE",
      type: "contextual_note",
    });
    expect(mem.content).toBe("creds: [REDACTED]");
    const fetched = await store.get(mem.id);
    expect(fetched.memory.content).toBe("creds: [REDACTED]");
    await store.close();
  });

  it("store() scrubs Slack tokens before persisting", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "slack: " + SLACK_BOT,
      type: "contextual_note",
    });
    expect(mem.content).toBe("slack: [REDACTED]");
    await store.close();
  });

  it("store() scrubs Bearer tokens before persisting", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "Authorization: Bearer " + BEARER_VAL,
      type: "contextual_note",
    });
    expect(mem.content).toBe("Authorization: [REDACTED]");
    await store.close();
  });

  it("store() scrubs password assignments before persisting", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "password=hunter2password",
      type: "contextual_note",
    });
    expect(mem.content).toBe("[REDACTED]");
    await store.close();
  });

  it("update() scrubs secrets in new content", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "clean", type: "contextual_note" });
    const updated = await store.update(mem.id, {
      content: "token: ghp_012345678901234567890123456789012345",
    });
    expect(updated.content).toBe("token: [REDACTED]");
    const fetched = await store.get(mem.id);
    expect(fetched.memory.content).toBe("token: [REDACTED]");
    await store.close();
  });

  it("update() scrubs AWS secret keys in new content", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "clean", type: "contextual_note" });
    const updated = await store.update(mem.id, {
      content: "aws_secret_access_key=" + AWS_SECRET,
    });
    expect(updated.content).toBe("[REDACTED]");
    await store.close();
  });
});
