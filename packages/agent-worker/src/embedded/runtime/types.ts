import type { BashOperations } from "@mariozechner/pi-coding-agent";
import type { GatewayParams } from "../../shared/tool-implementations";

/**
 * Worker-side runtime provider.
 *
 * A worker never holds provider credentials and never names a provider over
 * the wire — it only turns gateway params into a {@link BashOperations} that
 * proxies `exec` to the single generic gateway route
 * (`/internal/runtime/exec`). The gateway derives the actual provider from the
 * signed worker token, resolves credentials vault-side, and runs the command.
 *
 * So a provider here is pure transport + the remote filesystem env layout; no
 * SDK, no secrets. Adding a provider is a declaration (one of these + a gateway
 * counterpart), not a new route or env flag.
 */
export interface WorkerRuntimeProvider {
  /** Stable id; must match the gateway-side provider id and the token claim. */
  readonly id: string;
  /**
   * Provider-specific remote env layout (HOME, TMPDIR, cache dirs) merged into
   * every command's environment so tools resolve paths inside the sandbox FS.
   */
  readonly remoteEnv: Record<string, string>;
  createBashOps(params: { gw: GatewayParams }): BashOperations;
}
