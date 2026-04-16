/**
 * Detects and redacts "sandbox leaks" — cases where the agent presents a
 * local workspace path (or a Claude `sandbox://` URL) as if it were a
 * user-downloadable artifact, without having actually called
 * `UploadUserFile`.
 *
 * Catches three structural delivery patterns (links, sandbox:// URLs,
 * HTML attributes) plus a semantic pattern: a workspace path presented as
 * "the file is at …" or "located at …" — the phrasing that tricks users
 * into thinking the path is reachable.
 */

/** Claude's `sandbox://` file-reference scheme — always a delivery claim. */
const SANDBOX_URL_RE = /\bsandbox:\/{1,2}[^\s)\]}'"<>]+/gi;

/**
 * Markdown link target pointing at a local workspace path, e.g.
 * `[report](/app/workspaces/foo/bar.pdf)` or `[x](file:///workspace/y)`.
 */
const LOCAL_MD_LINK_RE =
  /\]\(\s*((?:file:\/\/)?(?:\/app\/workspaces\/|\/workspace\/)[^\s)]+)\s*\)/gi;

/**
 * HTML `href`/`src` pointing at a local workspace path.
 * Group 1 = attribute name, group 2 = URL target.
 */
const LOCAL_HREF_RE =
  /\b(href|src)\s*=\s*["']((?:file:\/\/)?(?:\/app\/workspaces\/|\/workspace\/)[^"']+)["']/gi;

/**
 * A workspace path presented as a file location via delivery-intent phrasing
 * (e.g. "located at", "saved to", "file is at", "available at").
 * Only fires when the path has a file extension so directory descriptions
 * in ls-style probes are not flagged.
 *
 * Matches both bare and back-ticked paths:
 *   "The file is located at: /app/workspaces/.../report.pdf"
 *   "saved to `/workspace/output/data.csv`"
 */
const DELIVERY_PHRASE_RE =
  /(?:located at|saved (?:to|at|in)|file is (?:at|in)|available at|created (?:at|in)|stored (?:at|in)|written to|exported to|generated (?:at|in))[:\s]+`?((?:\/app\/workspaces\/|\/workspace\/)[^\s`]+\.\w{1,10})`?/gi;

export interface LeakCheckResult {
  /** True if the final message makes an unfulfilled file-delivery claim. */
  leaked: boolean;
  /** `finalText` with offending link/URL targets neutralised. Equal to
   * `finalText` when `leaked` is false. */
  redactedText: string;
}

/**
 * Inspect the agent's final user-facing message for unfulfilled file-delivery
 * claims. If `sawUploadedFileEvent` is true (the agent actually called
 * UploadUserFile during this turn), no check is performed — the agent did
 * deliver something, and any remaining path references are assumed
 * descriptive.
 */
export function checkSandboxLeak(
  finalText: string,
  sawUploadedFileEvent: boolean
): LeakCheckResult {
  if (sawUploadedFileEvent || !finalText) {
    return { leaked: false, redactedText: finalText };
  }

  const hasSandboxUrl = SANDBOX_URL_RE.test(finalText);
  const hasMdLink = LOCAL_MD_LINK_RE.test(finalText);
  const hasHref = LOCAL_HREF_RE.test(finalText);
  const hasDeliveryPhrase = DELIVERY_PHRASE_RE.test(finalText);

  // Reset lastIndex — `test()` on /g regexes advances state.
  SANDBOX_URL_RE.lastIndex = 0;
  LOCAL_MD_LINK_RE.lastIndex = 0;
  LOCAL_HREF_RE.lastIndex = 0;
  DELIVERY_PHRASE_RE.lastIndex = 0;

  if (!hasSandboxUrl && !hasMdLink && !hasHref && !hasDeliveryPhrase) {
    return { leaked: false, redactedText: finalText };
  }

  // Redact: neutralise the link targets so the user doesn't see a broken
  // "clickable" path, but keep the surrounding prose intact.
  let redacted = finalText;
  redacted = redacted.replace(SANDBOX_URL_RE, "[local file, not uploaded]");
  redacted = redacted.replace(LOCAL_MD_LINK_RE, "](about:blank)");
  redacted = redacted.replace(
    LOCAL_HREF_RE,
    (_match, attr: string) => `${attr}="about:blank"`
  );
  redacted = redacted.replace(
    DELIVERY_PHRASE_RE,
    (_match, _path: string, _offset: number, _full: string) => {
      // Reconstruct the phrase prefix (everything before the path) by
      // re-matching on the original substring. Simpler: replace the whole
      // match with a generic note.
      return "[file was created but not uploaded — use `UploadUserFile` to deliver it]";
    }
  );

  const note =
    "\n\n_Note: I referenced a local file but did not actually upload it. " +
    "Ask me to retry and I will use `UploadUserFile` to deliver it._";

  return { leaked: true, redactedText: `${redacted}${note}` };
}
