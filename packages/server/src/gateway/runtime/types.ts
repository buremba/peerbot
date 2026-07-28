/**
 * Gateway-side runtime-provider abstraction.
 *
 * A runtime provider executes a worker's bash command on some compute target
 * (a persistent/ephemeral sandbox, a remote host). The generic
 * `/internal/runtime/exec` route handles auth, provider selection (from the
 * signed worker token), credential resolution, and workspace validation, then
 * hands a fully-resolved {@link RuntimeExecContext} to `provider.exec`. The
 * provider owns only the SDK-specific bits (sandbox naming, network policy,
 * get-or-create, run). Adding a provider is a declaration — no new route.
 */

/** One credential field a provider needs (e.g. Vercel: token, teamId, projectId). */
export interface RuntimeCredentialField {
  /**
   * Logical key. The per-sandbox vault row is `sandbox:<sandboxId>:<key>`;
   * the value is surfaced to the provider as `credentials.values[key]`.
   */
  key: string;
  /** Deployment-wide system-env fallback var (e.g. "VERCEL_TOKEN"). */
  systemEnvVar: string;
  required: boolean;
  /**
   * Whether this field is a secret. Secret fields (e.g. an API token) are never
   * returned to the UI. Non-secret fields (`false` — e.g. teamId/projectId, which
   * are plain identifiers) may be surfaced for display. Defaults to secret.
   */
  secret?: boolean;
  /** Human label for the field in credential-entry UIs. */
  label?: string;
}

export interface ResolvedRuntimeCredentials {
  /** key → plaintext value, resolved gateway-side; never returned to the worker. */
  values: Record<string, string>;
  /** "byo" when any value came from the org vault, else "system". */
  source: "byo" | "system";
}

/** Everything the route resolves before handing off to a provider. */
export interface RuntimeExecContext {
  organizationId?: string;
  agentId: string;
  conversationId: string;
  /** Local workspace dir, already validated against the token's agent+conversation. */
  workspaceDir: string;
  credentials: ResolvedRuntimeCredentials;
  command: string;
  /** Raw requested cwd from the worker; the provider maps it onto its remote root. */
  cwd: unknown;
  /** Sanitized command env (provider-key-validated). */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Raw allowed-domains list from the worker; the provider derives its policy. */
  allowedDomains: unknown;
  /** Raw denied-domains list (signed claim); providers subtract it from the allow policy. */
  deniedDomains: unknown;
  /**
   * Nix package names already validated through `nixPackageAttrRef` by the
   * route. Providers may put these on a command line as-is; anything the
   * validator rejected never reaches here.
   */
  nixPackages?: string[];
}

/** Outcome of one `ensurePackages` call, surfaced to the worker as exec meta. */
export interface PackageProvisionResult {
  /** Package names that are on PATH after this call (installed now or already present). */
  installed: string[];
  /** Package names provisioning failed for. The tool is absent; the turn still runs. */
  failed: string[];
  /** True when the marker matched and nothing had to be installed. */
  cached: boolean;
  /** Why provisioning degraded, when it did. Logged and surfaced, never thrown. */
  error?: string;
}

export interface RuntimeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Provider-specific diagnostics surfaced to the worker as `sandbox`. */
  meta?: Record<string, unknown>;
}

export interface GatewayRuntimeProvider {
  /** Stable id; matches the worker-side provider id and the token claim. */
  readonly id: string;
  readonly credentialFields: RuntimeCredentialField[];
  /**
   * Optional: returns true when the provider can authenticate without an
   * explicit vault/system credential (e.g. Vercel via an ambient
   * `VERCEL_OIDC_TOKEN`). When true and no credential resolves, the route
   * proceeds with empty credentials and lets the provider SDK self-auth;
   * when absent/false, a missing credential fails closed.
   */
  canSelfAuth?(): boolean;
  /**
   * Optional: provision `ctx.nixPackages` into the compute target so the
   * contributed CLIs are on PATH for the subsequent {@link exec}. Called by the
   * generic route before `exec`, AFTER the network policy is in force (the nix
   * substituter hosts must be reachable or the install hangs on deny-by-default).
   *
   * ABSENT means "this provider cannot provision" — the honest-degradation path:
   * the route logs it and the tool is simply missing, rather than the turn
   * failing or the gateway pretending the package is there. Implementations must
   * likewise RESOLVE with `failed` populated rather than throwing; a package that
   * didn't install must never fail the whole turn.
   *
   * Idempotence is the implementation's job and must be sandbox-side state (a
   * marker file), never gateway memory — another replica handles the next
   * message and must reach the same conclusion without reading this pod.
   */
  ensurePackages?(ctx: RuntimeExecContext): Promise<PackageProvisionResult>;
  exec(ctx: RuntimeExecContext): Promise<RuntimeExecResult>;
}
