/**
 * Credential placeholders for the isolate lane.
 *
 * The guest never holds the job's OAuth access token. Before a run starts, the
 * host replaces it with an opaque `lobu_secret_<uuid>` placeholder and keeps
 * the real value here, in memory, for exactly as long as the run. When the
 * guest's `fetch` reaches the host, the placeholder is swapped back into the
 * request header it was sent in, after the egress decision has admitted the
 * destination and only for a destination that may carry a credential (HTTPS,
 * or the run's own machine when the allowlist names it exactly). A connector that logs its
 * context, persists it in a checkpoint or emits it in an event therefore leaks
 * a handle that is dead once the run ends, and the real token exists only on
 * the host side of the boundary.
 *
 * This covers `job.credentials` only. A run's other secret channels —
 * connection credentials and operator provider keys merged into `job.config`,
 * `job.sessionState`, and an `authenticate` run's `previousCredentials` — still
 * reach the guest verbatim; moving them behind this vault is separate work.
 *
 * The grammar is the gateway secret proxy's (`gateway/proxy/secret-proxy.ts`
 * mints the same `lobu_secret_<uuid>` for agent deployments and swaps it on
 * its own route); the two differ only in lifetime, a proxy mapping being
 * cached per pod under a TTL while a vault dies with its run.
 */
import { randomUUID } from 'node:crypto';
import { parseCredentialedHttpsUrl } from './transport.js';

/** Every placeholder starts with this, whichever side minted it. */
export const CREDENTIAL_PLACEHOLDER_PREFIX = 'lobu_secret_';

const PLACEHOLDER_PATTERN = /lobu_secret_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** `true` when the text carries something shaped like a placeholder, whoever minted it. */
export function containsCredentialPlaceholder(text: string): boolean {
  return text.includes(CREDENTIAL_PLACEHOLDER_PREFIX);
}

/** One placeholder the vault resolved into a request header. */
export interface CredentialSpend {
  placeholder: string;
  /** Lower-cased name of the header the real value went into. */
  header: string;
}

export interface SwapHeadersOptions {
  /**
   * Whether a plaintext `http:` destination may carry the credential. The
   * isolate lane grants this only to the run's own machine: a loopback or
   * reserved literal (or `localhost`) that the allowlist names exactly, which
   * is how a self-hosted install reaches a local service and how a fixture
   * reaches its loopback server. Everywhere else the transport's HTTPS rule
   * applies.
   */
  plaintextAllowed: boolean;
}

export class CredentialVault {
  private readonly values = new Map<string, string>();

  /** Hide `value` behind a fresh placeholder only this vault can resolve. */
  mint(value: string): string {
    const placeholder = `${CREDENTIAL_PLACEHOLDER_PREFIX}${randomUUID()}`;
    this.values.set(placeholder, value);
    return placeholder;
  }

  /** How many secrets the vault holds. */
  get size(): number {
    return this.values.size;
  }

  /**
   * Replace every placeholder in `headers` with its real value, in place, and
   * report which header each went into. Refuses, leaving the headers as they
   * were: a placeholder in the URL (a credential there lands in access logs,
   * referrers and error bodies upstream), one this vault did not mint (the
   * guest fabricated it, or replayed one from an earlier run), and a plaintext
   * destination unless `plaintextAllowed`. Header values that carry no
   * placeholder are never touched, so an unauthenticated `http:` request is
   * unaffected by the HTTPS rule.
   */
  swapHeaders(headers: Headers, url: URL, options: SwapHeadersOptions): CredentialSpend[] {
    if (containsCredentialPlaceholder(url.href)) {
      throw new TypeError('a credential placeholder may only be sent in a request header, not in the URL');
    }
    const spends: CredentialSpend[] = [];
    const resolved: Array<[string, string]> = [];
    for (const [name, value] of headers) {
      if (!containsCredentialPlaceholder(value)) continue;
      if (!options.plaintextAllowed) parseCredentialedHttpsUrl(url);
      if (containsCredentialPlaceholder(value.replace(PLACEHOLDER_PATTERN, ''))) {
        // The prefix without a well-formed id behind it: not something this lane
        // minted. Checked on what the GUEST sent, before the swap, because a
        // resolved value is allowed to be placeholder-shaped itself -- an agent
        // turn's provider key is the gateway's own `lobu_secret_` placeholder,
        // which this vault conceals behind one of its own.
        throw new TypeError(`the credential placeholder in header ${name} is not valid for this run`);
      }
      const swapped = value.replace(PLACEHOLDER_PATTERN, (placeholder) => {
        const real = this.values.get(placeholder);
        if (real === undefined) {
          throw new TypeError(`the credential placeholder in header ${name} is not valid for this run`);
        }
        spends.push({ placeholder, header: name });
        return real;
      });
      resolved.push([name, swapped]);
    }
    for (const [name, value] of resolved) headers.set(name, value);
    return spends;
  }

  /** Forget every value; the placeholders stop resolving. */
  clear(): void {
    this.values.clear();
  }
}
