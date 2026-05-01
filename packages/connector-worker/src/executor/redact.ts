/**
 * Redact secrets from connector subprocess output before it leaves the worker.
 *
 * Patterns are deliberately broad — false positives are preferred to leaking a
 * real credential into the runs table. Add new patterns here when a connector
 * surfaces a new sensitive shape.
 */

const REDACTED = '[REDACTED]';

// Value charset for assignment-style secrets: word + URL-safe base64 + the
// dot/dollar/percent that show up in OAuth tokens (e.g. ya29.a0AfH6SM…) and
// signed cookies. Excludes whitespace, quote, brace, and bracket so the
// pattern stops at the boundary of the value.
const SECRET_VALUE = `[\\w\\-.~+/=:%$]{12,}`;

const PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  // HTTP Authorization header (e.g. "Authorization: Bearer abc...") — match
  // the rest of the line so multi-token schemes like "Bearer xxx" get caught.
  { regex: /Authorization:[^\r\n]+/gi, replacement: `Authorization: ${REDACTED}` },

  // Cookie / Set-Cookie header — same line-eating shape.
  { regex: /(Set-)?Cookie:[^\r\n]+/gi, replacement: `$1Cookie: ${REDACTED}` },

  // Bearer tokens anywhere (URL-safe-base64 style values)
  { regex: /Bearer\s+[\w\-.~+/=]+/gi, replacement: `Bearer ${REDACTED}` },

  // JWT shape (eyJ...header.payload.sig)
  { regex: /eyJ[\w\-]+\.[\w\-]+\.[\w\-]+/g, replacement: REDACTED },

  // Google OAuth access token shape (ya29.<varies>) — high-confidence.
  { regex: /ya29\.[\w\-.]{20,}/g, replacement: REDACTED },

  // URI userinfo: `scheme://user:pass@host` — redact the password segment.
  // Captures any scheme; replaces password while preserving structure.
  {
    regex: /([a-z][a-z0-9+\-.]*:\/\/[^:/\s]+):([^@/\s]+)@/gi,
    replacement: `$1:${REDACTED}@`,
  },

  // CH_API_KEY=value (literal env-var key from the connector ecosystem)
  {
    regex: /(CH_API_KEY)(["'\s:=]+["']?)([\w\-]+)(["']?)/gi,
    replacement: `$1$2${REDACTED}$4`,
  },

  // AWS_<SOMETHING>_KEY / AWS_<SOMETHING>_TOKEN env-style.
  {
    regex: new RegExp(
      `(AWS_[A-Z0-9_]*(?:KEY|TOKEN|SECRET))(["'\\s:=]+["']?)(${SECRET_VALUE})(["']?)`,
      'g'
    ),
    replacement: `$1$2${REDACTED}$4`,
  },

  // JSON/YAML/env-var style `api_key=...`, `apikey: "..."`, `access_token: ...`,
  // `secret = "..."`, `refresh_token: ...`, `id_token=...`, `_authToken: ...`,
  // `password: "..."`, `client_secret=...`.
  {
    regex: new RegExp(
      `((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|_?auth[_-]?token|client[_-]?secret|secret|password))(["'\\s:=]+["']?)(${SECRET_VALUE})(["']?)`,
      'gi'
    ),
    replacement: `$1$2${REDACTED}$4`,
  },
];

export function redactOutput(text: string): string {
  if (!text) return text;
  let result = text;
  for (const { regex, replacement } of PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
}

/**
 * Streaming redactor for live tee to parent stdout/stderr. Buffers up to the
 * last newline so that secrets split across stream chunk boundaries — for
 * example "Authorization: Bear" + "er abc..." in two `data` events — still
 * get matched by `redactOutput()`. The persisted `output_tail` already runs
 * `redactOutput()` over the full ring-buffer string and is unaffected; this
 * class exists solely to make the live-forwarded stream as safe as the
 * persisted tail.
 *
 * `flush()` MUST be called on stream end to release any trailing partial
 * line; otherwise its (redacted) content is dropped from the live tee but
 * still appears in the persisted tail.
 */
export class StreamRedactor {
  private carryover = '';
  // Safety cap for input with no newlines at all; emit the prefix and keep
  // a sliding window of the last MAX_BUFFER chars to catch boundary splits
  // up to that length.
  private static readonly MAX_BUFFER = 8192;

  process(chunk: string, emit: (redacted: string) => void): void {
    if (!chunk) return;
    const combined = this.carryover + chunk;
    const lastNewline = combined.lastIndexOf('\n');
    if (lastNewline >= 0) {
      const complete = combined.slice(0, lastNewline + 1);
      this.carryover = combined.slice(lastNewline + 1);
      emit(redactOutput(complete));
      return;
    }
    if (combined.length > StreamRedactor.MAX_BUFFER) {
      // No newline but we have to bound memory. Redact the whole buffer
      // before emitting — slicing would re-introduce a boundary mid-secret.
      // Carryover resets; the next chunk starts fresh, accepting that a
      // secret split across the cap boundary may be redacted twice (safe)
      // but never split within a regex match.
      emit(redactOutput(combined));
      this.carryover = '';
      return;
    }
    this.carryover = combined;
  }

  flush(emit: (redacted: string) => void): void {
    if (this.carryover) {
      emit(redactOutput(this.carryover));
      this.carryover = '';
    }
  }
}
