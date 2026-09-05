import { createHash } from "node:crypto";
import { createLogger, normalizeDomainPattern } from "@lobu/core";
import { patternReaches } from "@lobu/connector-sdk/egress-policy";
import { nixPackageAttrRef } from "@lobu/connector-sdk/nix-package";
import { type NetworkPolicy, Sandbox } from "@vercel/sandbox";
import {
  NIX_SUBSTITUTER_DOMAINS,
  nixPackageSetHash,
  sanitizeNixPackages,
} from "../packages.js";
import { remoteCwd } from "../workspace.js";
import {
  RuntimeInfrastructureError,
  type RuntimeExecutionOutcome,
} from "../types.js";
import type {
  GatewayRuntimeProvider,
  PackageProvisionResult,
  RuntimeExecContext,
  RuntimeExecResult,
} from "../types.js";

const logger = createLogger("vercel-runtime");

const REMOTE_WORKSPACE_DIR = "/vercel/sandbox";

/**
 * Writable home for the single-user Nix profile and Lobu's package profiles.
 * The Nix store itself remains at `/nix` inside the sandbox microVM.
 *
 * Deliberately OUTSIDE the agent-writable `/vercel/sandbox`: provisioning runs as root
 * while the worker writes the workspace unprivileged, so any provisioning path
 * the worker can replace with a symlink would be followed as root — by the
 * marker write, by `nix.conf`, and by the installer's own writes under HOME.
 * `/opt` is root-owned, so the worker cannot plant anything on these paths; it
 * only ever needs read+execute on the profile's `bin`.
 */
const NIX_HOME = "/opt/lobu-nix";

/**
 * Package source for `nix profile install`. A `tarball+https://` flake ref
 * pointing at the channel keeps resolution on hosts already granted by
 * {@link NIX_SUBSTITUTER_DOMAINS}; the bare `nixpkgs#` indirect ref would
 * resolve via github.com, which is not granted and made cold installs fail.
 */
const NIXPKGS_CHANNEL_FLAKE =
  "tarball+https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.xz";

/**
 * Sandbox-side mutex for the installer + profile + marker. Several execs can
 * land on one sandbox concurrently (multi-replica), and each cold path
 * bootstraps Nix and rewrites the shared profile symlink and marker file.
 * Without serialization two of them interleave — one deleting `$PROFILE`
 * while the other installs into it. `flock` is in util-linux, present in the
 * sandbox image; the guarded block re-checks the profile after acquiring, so
 * the loser of the race takes the cache-hit path instead of reinstalling.
 */
const NIX_LOCK_PATH = `${NIX_HOME}/.lobu-provision.lock`;
/** Sandbox-side provisioning state — see `nixPackageSetHash`. Never a gateway Map. */
const PACKAGE_MARKER_PATH = `${NIX_HOME}/.lobu-packages`;

/** How long a cold nix bootstrap + install may take before we give up on it. */
function provisionTimeoutMs(): number {
  return parsePositiveInt(
    process.env.LOBU_RUNTIME_PROVISION_TIMEOUT_MS,
    300_000
  );
}

/**
 * Pinned single-user nix installer. Version-pinned rather than floating
 * (`nixos.org/nix/install`) for two reasons: a pinned artifact is a fixed
 * supply-chain surface, and `releases.nixos.org` is already a substituter host
 * so no extra egress grant is needed for the bootstrap itself.
 *
 * `LOBU_NIX_INSTALLER_URL` overrides the installer artifact. Its host must also
 * be present in the agent's egress allowlist. The value is interpolated into a
 * shell command, so it is accepted only as a plain https URL with no
 * shell-significant characters — an operator typo must fall back to the pinned
 * default rather than run something else.
 */
const DEFAULT_NIX_INSTALLER_URL =
  "https://releases.nixos.org/nix/nix-2.28.4/install";

export function nixInstallerUrl(): string {
  const override = process.env.LOBU_NIX_INSTALLER_URL?.trim();
  if (!override) return DEFAULT_NIX_INSTALLER_URL;
  // Deliberately narrower than RFC 3986: `$ & ' ( ) ; * ! ,` are legal URL
  // characters AND shell metacharacters, so they are rejected rather than
  // quoted. No real installer URL needs them.
  if (!/^https:\/\/[A-Za-z0-9._~:/?#@=%+-]+$/.test(override)) {
    logger.warn(
      "LOBU_NIX_INSTALLER_URL is not a plain https URL — using the pinned default"
    );
    return DEFAULT_NIX_INSTALLER_URL;
  }
  return override;
}

type SnapshotRetention = {
  snapshotExpiration?: number;
  keepLastSnapshots?: {
    count: number;
    expiration?: number;
    deleteEvicted?: boolean;
  };
};

type VercelCredentials = {
  token: string;
  teamId: string;
  projectId: string;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function snapshotRetention(): SnapshotRetention {
  const snapshotExpiration = parseNonNegativeInt(
    process.env.LOBU_VERCEL_SANDBOX_SNAPSHOT_EXPIRATION_MS
  );
  const keepCount = Math.min(
    10,
    Math.max(
      1,
      parsePositiveInt(process.env.LOBU_VERCEL_SANDBOX_KEEP_LAST_SNAPSHOTS, 1)
    )
  );
  return {
    ...(snapshotExpiration !== undefined ? { snapshotExpiration } : {}),
    keepLastSnapshots: {
      count: keepCount,
      ...(snapshotExpiration !== undefined
        ? { expiration: snapshotExpiration }
        : {}),
      deleteEvicted: parseBoolean(
        process.env.LOBU_VERCEL_SANDBOX_DELETE_EVICTED_SNAPSHOTS,
        true
      ),
    },
  };
}

/**
 * The credential resolver hands us token/teamId/projectId together (all
 * `required`), but stay defensive: an empty `values` map means "fall back to
 * the Vercel SDK's ambient/OIDC auth" exactly as the original route did.
 */
function vercelCredentials(
  values: Record<string, string>
): Partial<VercelCredentials> {
  const { token, teamId, projectId } = values;
  const present = [token, teamId, projectId].filter((value) => !!value).length;
  if (present === 0) return {};
  if (present !== 3 || !token || !teamId || !projectId) {
    throw new Error(
      "VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID must be set together"
    );
  }
  return { token, teamId, projectId };
}

function stableSandboxName(params: {
  organizationId?: string;
  agentId: string;
  conversationId: string;
}): string {
  const prefix = (process.env.LOBU_VERCEL_SANDBOX_NAME_PREFIX || "lobu")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const org = (params.organizationId || "orgless")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const agent = params.agentId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const hash = createHash("sha256")
    .update(
      `${params.organizationId || ""}:${params.agentId}:${params.conversationId}`
    )
    .digest("hex")
    .slice(0, 16);
  return [prefix || "lobu", org || "orgless", agent || "agent", hash]
    .join("-")
    .slice(0, 100);
}

function sameSnapshotRetention(
  actual: Sandbox["keepLastSnapshots"],
  expected: SnapshotRetention["keepLastSnapshots"],
  actualExpiration: Sandbox["snapshotExpiration"],
  expectedExpiration: SnapshotRetention["snapshotExpiration"]
): boolean {
  return (
    actual?.count === expected?.count &&
    actual?.expiration === expected?.expiration &&
    actual?.deleteEvicted === expected?.deleteEvicted &&
    actualExpiration === expectedExpiration
  );
}

function normalizeAllowedDomain(domain: string): string | null {
  const trimmed = domain.trim();
  if (!trimmed) return null;
  if (trimmed === "*") return "*";
  if (!/^[A-Za-z0-9.*_-]+(?::\d+)?$/.test(trimmed)) return null;
  // Canonicalize (lowercase + punycode, "*.x" collapses to ".x") so
  // allow/deny overlap checks compare the one form DNS actually resolves —
  // a mixed-case deny must still subtract its allow entry.
  const canonical = normalizeDomainPattern(trimmed);
  if (canonical.startsWith(".")) return `*${canonical}`;
  return canonical;
}

/**
 * True when `entry` (a normalized allow pattern, possibly `*.suffix`) overlaps
 * `denied` (same forms) in either direction. The sandbox network policy can
 * only express an allow list, so any allow entry a deny covers — or that
 * covers a deny — must be dropped rather than granted (fail closed).
 *
 * Compared in the shared `.suffix` grammar with any `:port` qualifier
 * stripped, so "evil.example.com:443" cannot dodge a deny on
 * "evil.example.com". Both sides pass `wildcardCoversRoot: true`, which is the
 * fail-closed choice here: it widens what counts as an overlap, and an overlap
 * only ever drops an allow entry.
 */
function overlapsDeny(entry: string, denied: string[]): boolean {
  const toPattern = (p: string) =>
    p.replace(/:\d+$/, "").replace(/^\*\./, ".");
  const allow = toPattern(entry);
  return denied.some((deny) => {
    const covering = toPattern(deny);
    return (
      patternReaches(covering, allow, { wildcardCoversRoot: true }) ||
      patternReaches(allow, covering, { wildcardCoversRoot: true })
    );
  });
}

/**
 * @param extraAllowed gateway-DERIVED hosts (never worker-supplied) to add to
 *   the allow set — the nix substituters, added only when there is a validated
 *   package set to install. They are still subject to the denylist below: an
 *   operator who explicitly denies `cache.nixos.org` gets no package install,
 *   not a silent exemption.
 */
function networkPolicyFromDomains(
  value: unknown,
  deniedValue?: unknown,
  extraAllowed: string[] = []
): NetworkPolicy {
  if (!Array.isArray(value) && extraAllowed.length === 0) return "deny-all";
  const normalize = (input: unknown) =>
    (Array.isArray(input) ? input : [])
      .filter((entry): entry is string => typeof entry === "string")
      .map(normalizeAllowedDomain)
      .filter((entry): entry is string => !!entry);
  const domains = [...normalize(value), ...normalize(extraAllowed)];
  const denied = normalize(deniedValue);
  if (domains.includes("*") && denied.length === 0) return "allow-all";
  // The provider policy has no deny primitive, so denies are enforced by
  // subtraction: drop "*" (an unbounded allow can't honor exclusions) and
  // any allow entry that overlaps a denied pattern.
  const allowed = domains.filter(
    (entry) => entry !== "*" && !overlapsDeny(entry, denied)
  );
  return allowed.length > 0
    ? { allow: Array.from(new Set(allowed)) }
    : "deny-all";
}

/**
 * Normalize a provider SDK throw into a {@link RuntimeInfrastructureError}.
 *
 * The SDK's `APIError` carries the status on `response` and repeats it in the
 * message text; its own retry gives up when `Retry-After` exceeds its ceiling,
 * so a sustained 429 arrives here unretried. Reading the status off the error
 * avoids recovering it by matching that message.
 */
function asRuntimeInfrastructureError(
  error: unknown,
  stage: string,
  outcome: RuntimeExecutionOutcome
): RuntimeInfrastructureError {
  if (error instanceof RuntimeInfrastructureError) return error;
  const candidate = error as
    | { response?: { status?: unknown }; status?: unknown }
    | undefined;
  const raw = candidate?.response?.status ?? candidate?.status;
  const status = typeof raw === "number" ? raw : undefined;
  const detail = error instanceof Error ? error.message : String(error);
  return new RuntimeInfrastructureError(
    `Sandbox runtime failed to ${stage}: ${detail}`,
    { status, outcome, cause: error }
  );
}

/**
 * argv for running `command` with `cwd` established, in ONE sandbox execution.
 *
 * The outer non-login shell only creates and enters the directory, then `exec`s
 * the real `/bin/bash -lc "$2"`, replacing the process. Both values are argv
 * entries rather than interpolated text, for two reasons learned the hard way:
 *
 *  - Prepending `mkdir -p X && cd X &&` textually changed the submitted
 *    command's meaning. `&&` binds tighter than `&`, so `sleep 0 & pwd`
 *    backgrounded the cwd setup and ran `pwd` in the default directory; a
 *    comment-only command made the trailing `&&` a syntax error.
 *  - Running it with `eval` in the outer shell leaked that shell's positional
 *    state: `$0` was "lobu-exec", `$1` the cwd, `$#` 2 — where a plain
 *    `bash -lc` gives "bash", "" and 0.
 *
 * A separate `sandbox.fs.mkdir()` is not used because the SDK implements its
 * recursive branch as a real command execution, doubling the command-API rate.
 */
export function execArgv(cwd: string, command: string): string[] {
  return [
    "-c",
    'mkdir -p -- "$1" && cd -- "$1" && exec /bin/bash -lc "$2"',
    "lobu-exec",
    cwd,
    command,
  ];
}

function nixHostsReachable(ctx: RuntimeExecContext): boolean {
  const policy = networkPolicyFromDomains(
    ctx.allowedDomains,
    ctx.deniedDomains,
    NIX_SUBSTITUTER_DOMAINS
  );
  if (policy === "allow-all") return true;
  if (policy === "deny-all") return false;
  const allowed = policy.allow;
  if (!Array.isArray(allowed)) return false;
  return NIX_SUBSTITUTER_DOMAINS.every((domain) => allowed.includes(domain));
}

async function getSandbox(params: {
  name: string;
  networkPolicy: NetworkPolicy;
  credentials: Record<string, string>;
}): Promise<Sandbox> {
  const timeout = parsePositiveInt(
    process.env.LOBU_VERCEL_SANDBOX_TIMEOUT_MS,
    parsePositiveInt(process.env.TIMEOUT_MINUTES, 10) * 60 * 1000
  );
  const vcpus = parsePositiveInt(process.env.LOBU_VERCEL_SANDBOX_VCPUS, 1);
  const runtime =
    process.env.LOBU_VERCEL_SANDBOX_RUNTIME ||
    process.env.VERCEL_SANDBOX_DEFAULT_RUNTIME ||
    "node24";
  const retention = snapshotRetention();
  const sandbox = await Sandbox.getOrCreate({
    name: params.name,
    ...vercelCredentials(params.credentials),
    persistent: true,
    runtime,
    timeout,
    resources: { vcpus },
    networkPolicy: params.networkPolicy,
    ...retention,
    tags: { app: "lobu", backend: "worker" },
  });

  if (
    JSON.stringify(sandbox.networkPolicy) !==
      JSON.stringify(params.networkPolicy) ||
    sandbox.timeout !== timeout ||
    sandbox.vcpus !== vcpus ||
    !sameSnapshotRetention(
      sandbox.keepLastSnapshots,
      retention.keepLastSnapshots,
      sandbox.snapshotExpiration,
      retention.snapshotExpiration
    )
  ) {
    await sandbox.update({
      networkPolicy: params.networkPolicy,
      resources: { vcpus },
      timeout,
      ...retention,
    });
  }
  return sandbox;
}

/**
 * Resolve the sandbox for one request. Shared by `ensurePackages` and `exec` so
 * both see the SAME network policy — provisioning must not create the sandbox
 * with substituter access that the subsequent `exec` then revokes (each
 * `getOrCreate` reconciles the policy, so a divergent second call would churn
 * the sandbox on every single command).
 */
async function sandboxForRequest(ctx: RuntimeExecContext): Promise<Sandbox> {
  const packages = sanitizeNixPackages(ctx.nixPackages);
  return getSandbox({
    name: stableSandboxName({
      organizationId: ctx.organizationId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
    }),
    networkPolicy: networkPolicyFromDomains(
      ctx.allowedDomains,
      ctx.deniedDomains,
      // Only widen for the substituters when there is actually something to
      // install — an agent with no contributed packages keeps the exact policy
      // its operator configured.
      packages.length > 0 ? NIX_SUBSTITUTER_DOMAINS : []
    ),
    credentials: ctx.credentials.values,
  });
}

/**
 * Shell script that brings `packages` onto PATH inside the sandbox.
 *
 * Single-user Nix (`--no-daemon`) uses `/nix` inside the sandbox microVM and a
 * root-owned HOME at `NIX_HOME`. Provisioning runs with the provider's `sudo`
 * option because the standard installer creates `/nix`.
 * `nix profile install` is used rather than `nix-shell -p` because the profile
 * persists across messages, which is what makes the marker-file skip meaningful.
 *
 * Every interpolated package name has ALREADY been through `nixPackageAttrRef`
 * (twice: `sanitizeNixPackages`, then per-element below), so no shell
 * metacharacter can be present. The double check is deliberate — this string
 * becomes a command line, and a future caller that forgets to sanitize must not
 * turn that omission into a sandbox escape.
 */
function provisionScript(packages: string[], marker: string): string {
  for (const pkg of packages) nixPackageAttrRef(pkg);
  // `nixpkgs#pkg` is an INDIRECT flake ref: the registry resolves it through
  // github.com, which is not in NIX_SUBSTITUTER_DOMAINS — a cold install died
  // unless the agent happened to allow GitHub for its own reasons. The channel
  // tarball is the same package set from a host the sandbox is already granted
  // (channels.nixos.org 302s to releases.nixos.org, both in the allow list),
  // so provisioning depends only on hosts this module itself guarantees.
  const attrs = packages
    .map((pkg) => `"${NIXPKGS_CHANNEL_FLAKE}#${pkg}"`)
    .join(" ");
  return [
    "set -eu",
    // Without pipefail the installer masks a failed download: `sh` reads the
    // empty stdin left by a dead `curl` and exits 0, so the real failure only
    // surfaces later as a confusing missing-nix.sh error.
    "set -o pipefail",
    `export NIX_HOME=${NIX_HOME}`,
    `PROFILE="$NIX_HOME/profiles/${marker}"`,
    `mkdir -p "$NIX_HOME/profiles"`,
    // Serialize every shared profile/marker mutation, including cache hits.
    // Commands use hash-addressed profiles, but leaving the mutable selector
    // outside the lock makes the stated cross-replica contract false and causes
    // avoidable marker churn between concurrent package sets.
    `exec 9>"${NIX_LOCK_PATH}"`,
    `flock 9`,
    // Marker + hash-addressed profile match → the exact set is installed. The
    // profile existence check prevents a stale marker from hiding corruption.
    `if [ "$(cat ${PACKAGE_MARKER_PATH} 2>/dev/null || true)" = "${marker}" ] && [ -d "$PROFILE/bin" ]; then ln -sfn "$PROFILE" "$NIX_HOME/profile"; echo "lobu-packages: cached"; exit 0; fi`,
    `export HOME="$NIX_HOME"`,
    `export NIX_CONF_DIR="$NIX_HOME/etc"`,
    `mkdir -p "$NIX_CONF_DIR"`,
    `printf 'experimental-features = nix-command flakes\\n' > "$NIX_CONF_DIR/nix.conf"`,
    // A previously installed exact set can be selected without network access.
    `if [ -d "$PROFILE/bin" ]; then ln -sfn "$PROFILE" "$NIX_HOME/profile"; printf '%s' "${marker}" > ${PACKAGE_MARKER_PATH}; echo "lobu-packages: cached"; exit 0; fi`,
    // Bootstrap once; subsequent turns reuse the store already in the filesystem.
    `if [ ! -x "$NIX_HOME/.nix-profile/bin/nix" ]; then`,
    `  curl -fsSL ${nixInstallerUrl()} | sh -s -- --no-daemon --no-channel-add`,
    `fi`,
    // Sourced with `set +u` because the profile script is third-party and reads
    // environment variables a bare provisioning shell need not have set. `set
    // -e` still applies, so a nix.sh missing after a failed bootstrap aborts.
    `set +u; . "$NIX_HOME/.nix-profile/etc/profile.d/nix.sh"; set -u`,
    // One immutable profile per exact set: removed declarations disappear from
    // PATH, and a failed partial attempt is deleted before the next retry.
    `rm -f "$PROFILE" "$PROFILE"-*-link`,
    `if ! nix profile install --profile "$PROFILE" ${attrs}; then rm -f "$PROFILE" "$PROFILE"-*-link; exit 1; fi`,
    `ln -sfn "$PROFILE" "$NIX_HOME/profile"`,
    `printf '%s' "${marker}" > ${PACKAGE_MARKER_PATH}`,
    `echo "lobu-packages: installed"`,
  ].join("\n");
}

/** Select an already-built exact profile without contacting a Nix host. */
function cachedProfileScript(marker: string): string {
  return [
    "set -eu",
    `export NIX_HOME=${NIX_HOME}`,
    `PROFILE="$NIX_HOME/profiles/${marker}"`,
    `exec 9>"${NIX_LOCK_PATH}"`,
    `flock 9`,
    `if [ ! -d "$PROFILE/bin" ]; then exit 75; fi`,
    `ln -sfn "$PROFILE" "$NIX_HOME/profile"`,
    `printf '%s' "${marker}" > ${PACKAGE_MARKER_PATH}`,
    `echo "lobu-packages: cached"`,
  ].join("\n");
}

/**
 * Prefix the worker's command with the PATH export that makes provisioned
 * packages visible.
 *
 * Done in the COMMAND rather than via `runCommand({ env })` because the profile
 * dir must be *prepended* to whatever PATH the login shell computes. An `env`
 * entry would have to name the full PATH, which the gateway does not know (it
 * is the base image's), and a literal `$PATH` there is not expanded — it would
 * be passed through as the string `$PATH` and break every command in the
 * sandbox. Under `bash -lc` the export below expands correctly.
 *
 * Only when provisioning SUCCEEDED. The sandbox is persistent, so a failed
 * install can leave a profile from an earlier, different package set; exposing
 * it would contradict the `failed` list the same response reports and give the
 * agent a tool the gateway just said it does not have.
 *
 * PATH names the HASH-ADDRESSED profile, never the mutable `profile` symlink:
 * concurrent execs in one persistent conversation sandbox can carry different
 * signed `nixPackages` after its tooling configuration changes. Addressing the
 * exact set keeps each exec on the packages ITS token was signed for. The path
 * is derived from `nixPackageSetHash` over route-validated names — a hex digest,
 * so nothing attacker-influenced reaches the command line.
 */
function withProvisionedPath(ctx: RuntimeExecContext): string {
  if (!ctx.provisioned || ctx.provisioned.failed.length > 0) return ctx.command;
  if (ctx.provisioned.installed.length === 0) return ctx.command;
  const marker = nixPackageSetHash(ctx.nixPackages ?? []);
  return `export PATH="${NIX_HOME}/profiles/${marker}/bin:$PATH"\n${ctx.command}`;
}

/**
 * Vercel persistent-sandbox runtime (gateway side). The sandbox name is
 * deterministic per (org, agent, conversation) so messages resume the same
 * filesystem; the filesystem is the persistent source of truth (no file sync).
 */
export const __testOnly = {
  cachedProfileScript,
  networkPolicyFromDomains,
  execArgv,
  nixHostsReachable,
  provisionScript,
  withProvisionedPath,
};

export const vercelGatewayRuntimeProvider: GatewayRuntimeProvider = {
  id: "vercel",
  credentialFields: [
    {
      key: "token",
      systemEnvVar: "VERCEL_TOKEN",
      required: true,
      secret: true,
      label: "Access token",
    },
    {
      key: "teamId",
      systemEnvVar: "VERCEL_TEAM_ID",
      required: true,
      secret: false,
      label: "Team ID",
    },
    {
      key: "projectId",
      systemEnvVar: "VERCEL_PROJECT_ID",
      required: true,
      secret: false,
      label: "Project ID",
    },
  ],
  canSelfAuth(): boolean {
    // Vercel's recommended auth: an ambient OIDC token (present when Lobu runs
    // on Vercel, or pulled via `vercel env pull`). The SDK self-resolves it.
    return !!process.env.VERCEL_OIDC_TOKEN?.trim();
  },
  async ensurePackages(
    ctx: RuntimeExecContext
  ): Promise<PackageProvisionResult> {
    const packages = sanitizeNixPackages(ctx.nixPackages);
    if (packages.length === 0) {
      return { installed: [], failed: [], cached: true };
    }
    const marker = nixPackageSetHash(packages);
    try {
      const sandbox = await sandboxForRequest(ctx);
      if (!nixHostsReachable(ctx)) {
        const cached = await sandbox.runCommand({
          cmd: "/bin/bash",
          args: ["-lc", cachedProfileScript(marker)],
          cwd: REMOTE_WORKSPACE_DIR,
          timeoutMs: 10_000,
          // Must match the provision path below: that call creates NIX_HOME as
          // root, so selecting an existing profile (which relinks `profile` and
          // rewrites the marker inside it) needs the same privilege. Without
          // this, a cache hit fails on permissions once the nix hosts are
          // denied — the exact path this branch is supposed to recover.
          sudo: true,
        });
        if (cached.exitCode === 0) {
          return { installed: packages, failed: [], cached: true };
        }
        return {
          installed: [],
          failed: packages,
          cached: false,
          error: "Nix package hosts are blocked by the sandbox network policy",
        };
      }
      const result = await sandbox.runCommand({
        cmd: "/bin/bash",
        args: ["-lc", provisionScript(packages, marker)],
        cwd: REMOTE_WORKSPACE_DIR,
        timeoutMs: provisionTimeoutMs(),
        // The official single-user installer creates `/nix`. Vercel's runtime
        // grants root only when the SDK call explicitly opts into sudo.
        sudo: true,
      });
      const stdout = await result.stdout();
      if (result.exitCode !== 0) {
        const stderr = await result.stderr();
        // Degrade honestly: the tool is absent and we SAY so. Failing the turn
        // here would take down an agent whose main work has nothing to do with
        // the contributed CLI.
        logger.warn(
          { packages, exitCode: result.exitCode, stderr: stderr.slice(-2000) },
          "Nix package provisioning failed — sandbox continues without these packages"
        );
        return {
          installed: [],
          failed: packages,
          cached: false,
          error: `nix provisioning exited ${result.exitCode}`,
        };
      }
      return {
        installed: packages,
        failed: [],
        cached: stdout.includes("lobu-packages: cached"),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { packages, err: message },
        "Nix package provisioning errored — sandbox continues without these packages"
      );
      return { installed: [], failed: packages, cached: false, error: message };
    }
  },
  async exec(ctx: RuntimeExecContext): Promise<RuntimeExecResult> {
    // Provisioning happens before the agent's command exists, so ANY failure
    // here is the runtime's, never the command's.
    let sandbox: Sandbox;
    try {
      sandbox = await sandboxForRequest(ctx);
    } catch (error) {
      throw asRuntimeInfrastructureError(error, "provision sandbox", "not_started");
    }

    // The cwd is created by the command itself rather than by a separate
    // `sandbox.fs.mkdir()`: the SDK implements its recursive branch as a real
    // command execution, so a standalone call doubled the command-API rate for
    // every command — including ones touching no filesystem — and trips the
    // provider's rate limit. `mkdir -p` then `cd` gives the same guarantee in
    // one execution.
    const cwd = remoteCwd(ctx.cwd, ctx.workspaceDir, REMOTE_WORKSPACE_DIR);
    // Only the TRANSPORT is wrapped: a non-zero exitCode from the agent's own
    // command is a normal result and must flow through untouched.
    let result: Awaited<ReturnType<Sandbox["runCommand"]>>;
    try {
      result = await sandbox.runCommand({
        cmd: "/bin/bash",
        // Provisioned packages live in a sandbox-local profile, so PATH must
        // name it or the CLI is installed-but-invisible. Prepended (not
        // appended) so a declared package wins over an older copy baked into
        // the base image.
        args: execArgv(cwd, withProvisionedPath(ctx)),
        env: ctx.env,
        timeoutMs: ctx.timeoutMs,
      });
    } catch (error) {
      // Dispatch rejected. The SDK can reject after the command has started, so
      // this is "unknown", not "not_started" — retryable, but not a promise that
      // nothing happened.
      throw asRuntimeInfrastructureError(error, "run command", "unknown");
    }

    // Fetching the logs is a SEPARATE call, and by this point the command has
    // already executed. A failure here must never be reported as "your command
    // did not run" with a retry hint — re-running a command that already
    // succeeded duplicates its side effects (a POST sent twice, a file appended
    // twice). Report it as non-retryable and say the outcome is unknown.
    let stdout: string;
    let stderr: string;
    try {
      [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RuntimeInfrastructureError(
        `Sandbox runtime ran the command but could not retrieve its output: ${detail}. The command MAY have completed — do not assume it needs re-running.`,
        { retryable: false, outcome: "completed", cause: error }
      );
    }
    const exitCode = result.exitCode;

    return {
      stdout,
      stderr,
      exitCode,
      meta: {
        name: sandbox.name,
        persistent: sandbox.persistent,
        cwd: sandbox.cwd,
      },
    };
  },
};
