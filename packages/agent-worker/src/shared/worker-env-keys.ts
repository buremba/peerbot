/**
 * What of the worker's own environment may reach agent bash and the processes
 * it spawns.
 *
 * This is an ALLOWLIST, and deliberately so. It replaced a two-entry denylist
 * (`WORKER_TOKEN`, `DISPATCHER_URL`) that started from `process.env` and removed
 * those two, which meant every other variable the gateway holds — ENCRYPTION_KEY,
 * JWT_SECRET, BETTER_AUTH_SECRET, DATABASE_URL, every provider API key — was
 * readable from the agent's shell with a bare `echo $VAR`. No spawned binary and
 * no sandbox escape was needed; the values were placed in the interpreter's own
 * env. A denylist also fails open by construction: every secret added to the
 * gateway later is exposed until someone remembers to name it here.
 *
 * Adding an entry grants the agent read access to that value. Prefer passing a
 * value explicitly through the call site (see `remoteEnv` / contributed lease
 * vars) over widening this list.
 */

/** Exact names forwarded verbatim. */
export const WORKER_ENV_ALLOWLIST = [
  // Process basics. Without PATH the interpreter cannot resolve anything;
  // HOME/TMPDIR are re-pinned per-invocation to workspace subdirs.
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  // Locale + terminal, so CLI output is not mangled.
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  // Egress. Spawned binaries reach the network through the gateway proxy, which
  // enforces the per-agent domain allowlist; without these they bypass it or
  // fail outright. Both cases are honoured by curl/git/gh.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  // Read by the worker's own bootstrap: the declared tooling contribution and
  // the just-bash domain allowlist.
  "NIX_PACKAGES",
  "JUST_BASH_ALLOWED_DOMAINS",
  // Nix needs these to resolve a provisioned package's store paths.
  "NIX_PATH",
  "NIX_PROFILES",
  "NIX_SSL_CERT_FILE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/**
 * Prefixes forwarded wholesale.
 *
 * `LOBU_AGENT_ENV_` is the explicit channel for values an operator intends the
 * agent to see, so a new one needs no change here. Nothing else is prefix-
 * matched: `LOBU_` at large would re-admit LOBU_CLOUD_PAT and friends.
 */
export const WORKER_ENV_ALLOWLIST_PREFIXES = ["LOBU_AGENT_ENV_"] as const;

/**
 * Build the environment for agent bash from the worker's own, keeping only
 * allowlisted names.
 *
 * `extra` is merged AFTER filtering and is not itself filtered — it carries
 * values the call site means to pass (a connector's contributed lease var, a
 * runtime provider's `remoteEnv`), which are by definition intended for the
 * agent and are not the worker's ambient secrets.
 */
export function buildAgentEnv(
  env: Record<string, string | undefined>,
  extra?: Record<string, string | undefined>
): Record<string, string> {
  const allowed = new Set<string>(WORKER_ENV_ALLOWLIST);
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (
      allowed.has(key) ||
      WORKER_ENV_ALLOWLIST_PREFIXES.some((p) => key.startsWith(p))
    ) {
      out[key] = value;
    }
  }

  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== undefined) out[key] = value;
  }

  return out;
}
