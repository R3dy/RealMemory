/**
 * Basic secret scrubbing — replaces common credential patterns with [REDACTED].
 *
 * This is a lightweight regex-based pass; a more robust scrubber (entropy
 * detection, custom patterns, context-aware redaction) lands in Story 9.2.
 */

const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g, // AWS access keys
  /ghp_[a-zA-Z0-9]{36}/g, // GitHub personal access tokens
  /gho_[a-zA-Z0-9]{36}/g, // GitHub OAuth tokens
  /sk-[a-zA-Z0-9]{48}/g, // OpenAI API keys
  /-----BEGIN [A-Z]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z]+ PRIVATE KEY-----/g, // Private keys
  /(api_key|apikey|token|password|passwd|secret)["\s:=]+["']?([a-zA-Z0-9_\-]{20,})/gi, // Generic key=value
];

/**
 * Replace known secret patterns in `content` with `[REDACTED]`.
 * Idempotent: a clean string is returned unchanged.
 */
export function scrubSecrets(content: string): string {
  let scrubbed = content;
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[REDACTED]");
  }
  return scrubbed;
}
