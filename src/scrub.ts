/**
 * Secret scrubbing — replaces common credential patterns with [REDACTED].
 *
 * A regex-based pass covering AWS, GitHub, OpenAI, Slack, Bearer tokens, PEM
 * private keys, and generic `password=` / `api_key=` assignments. Each match
 * (including the key name for generic assignments) is replaced wholesale with
 * `[REDACTED]` so the secret value is never persisted.
 */

const SECRET_PATTERNS: RegExp[] = [
  // AWS access keys.
  /AKIA[0-9A-Z]{16}/g,
  // AWS secret keys (40-char base64 after an aws_secret_access_key assignment).
  /aws_secret_access_key["\s:=]+["']?[A-Za-z0-9/+=]{40}/gi,
  // GitHub personal access tokens.
  /ghp_[a-zA-Z0-9]{36}/g,
  // GitHub OAuth tokens.
  /gho_[a-zA-Z0-9]{36}/g,
  // GitHub app tokens.
  /ghs_[a-zA-Z0-9]{36}/g,
  // GitHub refresh tokens.
  /ghr_[a-zA-Z0-9]{76}/g,
  // OpenAI API keys.
  /sk-[a-zA-Z0-9]{48}/g,
  // Slack tokens (bot, user, app, oauth, legacy).
  /xox[bpoa]-[a-zA-Z0-9-]+/g,
  // Bearer tokens.
  /Bearer\s+[a-zA-Z0-9_\-.=]+/g,
  // Private keys (PEM format, any key type).
  /-----BEGIN\s+[A-Z\s]+PRIVATE\s+KEY-----[\s\S]*?-----END\s+[A-Z\s]+PRIVATE\s+KEY-----/g,
  // Generic password assignments (quoted or bare value, >= 4 chars).
  /(password|passwd|pwd)["\s:=]+["']?[^\s"']{4,}/gi,
  // Generic API key / token / secret assignments (quoted or bare value >= 20 chars).
  /(api_key|apikey|api-key|access_token|access-token|secret_key|secret-key)["\s:=]+["']?[a-zA-Z0-9_\-]{20,}/gi,
];

/**
 * Replace known secret patterns in `content` with `[REDACTED]`.
 * Idempotent: a clean string is returned unchanged.
 */
export function scrubSecrets(content: string): string {
  let scrubbed = content;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex — these are /g regexes reused across calls.
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, "[REDACTED]");
  }
  return scrubbed;
}
