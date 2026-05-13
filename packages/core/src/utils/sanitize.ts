/**
 * Sanitize filename to prevent path traversal attacks
 * Removes directory separators and dangerous characters
 *
 * @param filename - The filename to sanitize
 * @param maxLength - Maximum filename length (default: 255)
 * @returns Safe filename
 *
 * @example
 * ```typescript
 * sanitizeFilename("../../etc/passwd") // "etc_passwd"
 * sanitizeFilename("file<>|name.txt") // "file___name.txt"
 * ```
 */
export function sanitizeFilename(
  filename: string,
  maxLength: number = 255
): string {
  // Remove any directory path components
  const basename = filename.replace(/^.*[\\/]/, "");

  // Remove null bytes and other dangerous characters
  const sanitized = basename.replace(/[^\w\s.-]/g, "_");

  // Prevent hidden files and parent directory references
  const safe = sanitized.replace(/^\.+/, "").replace(/\.{2,}/g, ".");

  // Ensure filename is not empty after sanitization
  if (!safe || safe.length === 0) {
    return "unnamed_file";
  }

  // Limit filename length
  return safe.length > maxLength ? safe.substring(0, maxLength) : safe;
}

/**
 * Sanitize conversation ID for filesystem usage
 * Removes any characters that aren't safe for directory names
 *
 * @param conversationId - The conversation ID to sanitize
 * @returns Safe conversation ID
 *
 * @example
 * ```typescript
 * sanitizeConversationId("1756766056.836119") // "1756766056.836119"
 * sanitizeConversationId("thread/123/../456") // "thread_123___456"
 * ```
 */
export function sanitizeConversationId(conversationId: string): string {
  return conversationId.replace(/[^a-zA-Z0-9.-]/g, "_");
}

/**
 * Sanitize sensitive data from objects before logging
 * Redacts API keys, tokens, and other credentials
 *
 * @param obj - Object to sanitize
 * @param sensitiveKeys - Additional sensitive key names to redact
 * @returns Sanitized object safe for logging
 *
 * @example
 * ```typescript
 * const config = {
 *   apiKey: "secret-key-123",
 *   timeout: 5000,
 *   env: { TOKEN: "bearer-xyz" }
 * };
 *
 * sanitizeForLogging(config)
 * // {
 * //   apiKey: "[REDACTED:14]",
 * //   timeout: 5000,
 * //   env: { TOKEN: "[REDACTED:10]" }
 * // }
 * ```
 */
// Compiled once: substring-matches the default sensitive key names (case-insensitive).
// Equivalent to `.some(k => lowerKey.includes(k))` over the old array, but a single
// regex test per key instead of an N-way array scan.
const DEFAULT_SENSITIVE_KEY_RE =
  /(anthropic_api_key|api_?key|token|password|secret|authorization|bearer|credentials|private_?key)/i;

const MAX_SANITIZE_DEPTH = 8;

function isSensitiveKey(
  lowerKey: string,
  additionalLowered: readonly string[]
): boolean {
  if (DEFAULT_SENSITIVE_KEY_RE.test(lowerKey)) return true;
  for (const k of additionalLowered) {
    if (lowerKey.includes(k)) return true;
  }
  return false;
}

function sanitizeInner(
  obj: any,
  additionalLowered: readonly string[],
  depth: number,
  seen: WeakSet<object>
): any {
  if (!obj || typeof obj !== "object") return obj;
  if (depth >= MAX_SANITIZE_DEPTH) return obj;
  // Cycle guard: object graphs with back-references (Express req/res, error
  // .cause chains, ORM rows) would otherwise recurse forever. Depth cap above
  // already bounds stack depth, but returning "[Circular]" gives a more useful
  // log line and avoids cloning the same subtree N times for a graph with
  // multiple paths to the same node.
  if (seen.has(obj as object)) return "[Circular]";
  seen.add(obj as object);

  const sanitized = Array.isArray(obj) ? [...obj] : { ...obj };

  for (const key in sanitized) {
    const value = sanitized[key];
    if (typeof value === "string") {
      if (isSensitiveKey(key.toLowerCase(), additionalLowered)) {
        sanitized[key] = `[REDACTED:${value.length}]`;
      }
    } else if (value && typeof value === "object") {
      sanitized[key] = sanitizeInner(value, additionalLowered, depth + 1, seen);
    }
  }

  return sanitized;
}

export function sanitizeForLogging(
  obj: any,
  additionalSensitiveKeys: string[] = []
): any {
  if (!obj || typeof obj !== "object") {
    return obj;
  }
  const additionalLowered = additionalSensitiveKeys.map((k) => k.toLowerCase());
  return sanitizeInner(obj, additionalLowered, 0, new WeakSet());
}

/**
 * Strip entries with sensitive keys (exact-match) and drop undefined values.
 *
 * Unlike {@link sanitizeForLogging}, which recursively redacts sensitive values
 * in place, this helper returns a pruned copy with the sensitive keys removed
 * entirely. Intended for building a safe env record to hand off to child
 * processes.
 *
 * @param env - Source env record (string | undefined values)
 * @param sensitiveKeys - Exact key names to strip
 * @returns A record with undefined values dropped and sensitive keys omitted
 *
 * @example
 * ```typescript
 * stripEnv(process.env, ["WORKER_TOKEN", "DISPATCHER_URL"])
 * ```
 */
export function stripEnv(
  env: Record<string, string | undefined>,
  sensitiveKeys: readonly string[]
): Record<string, string> {
  const stripped: Record<string, string> = {};
  const blocked = new Set(sensitiveKeys);

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (blocked.has(key)) continue;
    stripped[key] = value;
  }

  return stripped;
}
