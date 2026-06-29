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
   * Logical key. The per-environment vault row is `environment:<envId>:<key>`;
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
  exec(ctx: RuntimeExecContext): Promise<RuntimeExecResult>;
}
