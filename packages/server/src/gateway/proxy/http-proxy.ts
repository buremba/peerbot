import type { LookupAddress } from "node:dns";
import * as dns from "node:dns/promises";
import * as http from "node:http";
import * as net from "node:net";
import { domainToASCII } from "node:url";
import type { WorkerTokenData } from "@lobu/core";
import { createLogger, verifyWorkerToken } from "@lobu/core";
import { constantTimeEqual } from "../../utils/constant-time-equal.js";
import {
  isUnrestrictedMode,
  loadAllowedDomains,
  loadDisallowedDomains,
} from "../config/network-allowlist.js";
import type { RevokedTokenStore } from "../auth/revoked-token-store.js";
import { getRevokedTokenStore } from "../auth/revoked-token-store.js";
import { recordGuardrailTrip } from "../guardrails/audit.js";
import type { GrantStore } from "../permissions/grant-store.js";
import type { PolicyStore } from "../permissions/policy-store.js";
import { EgressJudge } from "./egress-judge/judge.js";
import type { JudgeDecision } from "./egress-judge/types.js";
import {
  isReservedIp,
  normalizeIpLiteral,
  stripIpv6Brackets,
} from "./ssrf-guard.js";

const logger = createLogger("http-proxy");

/**
 * The worker network allow/deny config for one proxy server, resolved once from
 * the environment when the server starts. It is an immutable snapshot threaded
 * through the request handlers — there is deliberately NO process-wide mutable
 * cache. A lazily-populated module global (the previous design) read `process.env`
 * at whatever moment the first request happened to fire and then froze that value
 * for the life of the process, which made behavior order-dependent (and, in the
 * test runner where the module + env are shared across files, leaked one file's
 * env into another's). Resolving per-server removes that coupling entirely.
 */
export interface ResolvedNetworkConfig {
  allowedDomains: string[];
  deniedDomains: string[];
}

/**
 * Resolve the worker network allow/deny config from the current environment.
 * Called once per {@link startHttpProxy}. The pattern lists are pre-lowercased
 * here so the per-request matcher never re-lowercases on the hot path.
 */
export function resolveNetworkConfig(): ResolvedNetworkConfig {
  return {
    allowedDomains: loadAllowedDomains().map((d) => d.toLowerCase()),
    deniedDomains: loadDisallowedDomains().map((d) => d.toLowerCase()),
  };
}

interface TargetResolutionResult {
  ok: boolean;
  resolvedIp?: string;
  statusCode?: number;
  clientMessage?: string;
  reason?: string;
}

// Module-level grant store reference for domain grant checks
let proxyGrantStore: GrantStore | null = null;

// Injectable revoked-token store. Defaults to the process-wide singleton (the
// only DB-backed instance in prod). Tests inject a store so they can exercise
// the cross-replica revocation path — a jti revoked on "pod A" (a separate
// store instance writing the shared `revoked_tokens` table) must be denied by
// the proxy even though it was never seen by this pod's in-memory cache.
let proxyRevokedTokenStore: RevokedTokenStore | null = null;

function getProxyRevokedTokenStore(): RevokedTokenStore {
  return proxyRevokedTokenStore ?? getRevokedTokenStore();
}

/**
 * Override the revoked-token store the proxy consults. Production leaves this
 * null (uses the singleton); tests inject a store backed by an isolated cache
 * so they can simulate a revoke that happened on another replica.
 */
export function setProxyRevokedTokenStore(
  store: RevokedTokenStore | null
): void {
  proxyRevokedTokenStore = store;
}

// Module-level policy store + lazy egress judge. The judge is only used
// when a request matches a `judgedDomains` rule — most traffic never
// touches it.
let proxyPolicyStore: PolicyStore | null = null;
let proxyEgressJudge: EgressJudge | null = null;

/**
 * Set the policy store for the HTTP proxy to look up judged-domain rules.
 * Called during gateway initialization. Lazy-constructs the {@link EgressJudge}
 * on first configuration so tests can opt out by never calling this.
 */
export function setProxyPolicyStore(store: PolicyStore): void {
  proxyPolicyStore = store;
  if (!proxyEgressJudge) {
    proxyEgressJudge = new EgressJudge();
  }
}

/**
 * Set the grant store the proxy consults when resolving per-agent
 * allow/deny grants. Production wires this from `CoreServices`; tests use
 * it to install a mock or a fresh DB-backed store so the cross-org leakage
 * fixed in this PR can be exercised end-to-end.
 */
export function setProxyGrantStore(store: GrantStore): void {
  proxyGrantStore = store;
}

/**
 * Replace the lazy {@link EgressJudge} — tests inject a fake client here
 * so the proxy can be exercised end-to-end without hitting a real model.
 */
export function setProxyEgressJudge(judge: EgressJudge): void {
  proxyEgressJudge = judge;
}

/**
 * Outcome of a full access decision. When the judge is consulted,
 * `judge` carries the verdict so the caller can surface the reason to
 * the client and emit a structured audit log.
 */
interface AccessDecision {
  allowed: boolean;
  source: "global" | "grant" | "judge";
  judge?: JudgeDecision;
}

/**
 * Unified domain access check: global config → grant store → LLM judge.
 *
 * 1. If denied by global blocklist → block
 * 2. If allowed by global allowlist → check grantStore.isDenied() → allow/block
 * 3. If not in global list → check grantStore.hasGrant() → allow/block
 * 4. If still not decided and the agent has a judged-domain rule for the
 *    host → invoke the LLM judge → allow/block based on verdict
 */
async function checkDomainAccess(
  config: ResolvedNetworkConfig,
  hostname: string,
  agentId: string | undefined,
  organizationId: string | undefined,
  requestContext?: {
    method?: string;
    path?: string;
    conversationId?: string;
    userId?: string;
  }
): Promise<AccessDecision> {
  const global = config;

  // Canonicalize once so the denylist, allowlist, grant store, and judge all
  // match the same name (closes the trailing-dot FQDN blocklist bypass).
  hostname = canonicalizeHostname(hostname);

  // Global blocklist always takes precedence
  if (
    global.deniedDomains.length > 0 &&
    matchesDomainPattern(hostname, global.deniedDomains)
  ) {
    return { allowed: false, source: "global" };
  }

  // Check if globally allowed (unrestricted or in allowlist)
  const globallyAllowed = isHostnameAllowed(
    hostname,
    global.allowedDomains,
    global.deniedDomains
  );

  if (globallyAllowed) {
    // Even if globally allowed, a per-agent deny grant can override.
    // Pass `organizationId` explicitly — `GrantStore` falls back to the ALS
    // org context when omitted, but the raw Node HTTP proxy never sets ALS
    // and the WHERE clause would drop its `organization_id` predicate,
    // leaking grants/denies across tenants that share an agent id.
    if (proxyGrantStore && agentId) {
      const denied = await proxyGrantStore.isDenied(
        agentId,
        hostname,
        organizationId
      );
      if (denied) {
        logger.debug(`Domain ${hostname} denied via grant (agent: ${agentId})`);
        return { allowed: false, source: "grant" };
      }
    }
    return { allowed: true, source: "global" };
  }

  // Not globally allowed — check grant store for per-agent access
  if (proxyGrantStore && agentId) {
    const granted = await proxyGrantStore.hasGrant(
      agentId,
      hostname,
      organizationId
    );
    if (granted) {
      logger.debug(`Domain ${hostname} allowed via grant (agent: ${agentId})`);
      return { allowed: true, source: "grant" };
    }
  }

  // Fall through to the LLM egress judge when a matching rule exists.
  // PolicyStore is keyed by `(orgId, agentId)`; without an org id we refuse
  // to consult it — falling through to an unkeyed lookup would let another
  // tenant's policy decide our verdict.
  if (proxyPolicyStore && proxyEgressJudge && agentId && organizationId) {
    const rule = proxyPolicyStore.resolve(organizationId, agentId, hostname);
    if (rule) {
      const decision = await proxyEgressJudge.decide(
        {
          agentId,
          organizationId,
          hostname,
          method: requestContext?.method,
          path: requestContext?.path,
        },
        rule
      );
      const allowed = decision.verdict === "allow";
      if (!allowed) {
        // Egress denials share the guardrail audit trail: a judge DENY writes a
        // `guardrail-trip` event (stage `egress`) just like message-pipeline
        // guardrails. Enforcement stays here in the proxy — this is audit only.
        // Fire-and-forget: `recordGuardrailTrip` never rejects, so we don't
        // await it on the egress hot path. `agentId`/`organizationId` are both
        // guaranteed present by the enclosing guard.
        void recordGuardrailTrip({
          organizationId,
          agentId,
          conversationId: requestContext?.conversationId,
          userId: requestContext?.userId,
          stage: "egress",
          guardrail: decision.judgeName,
          reason: decision.reason,
          metadata: {
            hostname,
            verdict: decision.verdict,
            judgeSource: decision.source,
          },
        });
      }
      return {
        allowed,
        source: "judge",
        judge: decision,
      };
    }
  }

  return { allowed: false, source: "global" };
}

interface ProxyCredentials {
  deploymentName: string;
  token: string;
}

// The IP-literal normalization + reserved-range blocklist live in the shared
// `ssrf-guard.ts` module (imported above). `isReservedIp` and
// `normalizeIpLiteral` are the single source of truth for every SSRF guard in
// the server — this proxy used to carry a byte-for-byte duplicate, which is the
// drift class fixed here. `isBlockedIpAddress` is just the proxy-local alias.
const isBlockedIpAddress = isReservedIp;

type DnsLookupAllFn = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<LookupAddress[]>;

let dnsLookupOverride: DnsLookupAllFn | null = null;

export const __testOnly = {
  isBlockedIpAddress,
  checkDomainAccess,
  canonicalizeHostname,
  /**
   * Clear the explicitly-injected test doubles (stores + DNS override) so one
   * test file's injection doesn't leak into another. Network config is NOT here:
   * it's no longer a module global — each {@link startHttpProxy} resolves its own
   * immutable snapshot, and direct {@link checkDomainAccess} callers pass one in.
   */
  reset: () => {
    proxyGrantStore = null;
    proxyPolicyStore = null;
    proxyEgressJudge = null;
    proxyRevokedTokenStore = null;
    dnsLookupOverride = null;
  },
  setDnsLookup(fn: DnsLookupAllFn | null): void {
    dnsLookupOverride = fn;
  },
};

async function resolveAndValidateTarget(
  rawHostname: string
): Promise<TargetResolutionResult> {
  const hostname = stripIpv6Brackets(rawHostname);

  // Route the target literal through the single IP-normalization funnel
  // before anything else. This catches IPv4-mapped IPv6, NAT64, zone IDs
  // and compressed forms, and rejects anything that looks like an IP but
  // doesn't cleanly parse.
  const normalized = normalizeIpLiteral(hostname);
  if (normalized.kind === "invalid") {
    return {
      ok: false,
      statusCode: 403,
      clientMessage: `403 Forbidden - Malformed target host: ${hostname}`,
      reason: `target host is not a valid address (${hostname})`,
    };
  }
  if (normalized.kind !== "not-ip") {
    if (isBlockedIpAddress(hostname)) {
      return {
        ok: false,
        statusCode: 403,
        clientMessage: `403 Forbidden - Target IP not allowed: ${hostname}`,
        reason: `target is local/private IP (${hostname})`,
      };
    }
    // Pin the connection to the normalized literal — for IPv4-mapped /
    // NAT64 inputs this is the bare IPv4 we actually validated.
    return { ok: true, resolvedIp: normalized.value };
  }

  let addresses: LookupAddress[];
  try {
    addresses = dnsLookupOverride
      ? await dnsLookupOverride(hostname, { all: true, verbatim: true })
      : await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      statusCode: 502,
      clientMessage: `Bad Gateway: Could not resolve target host ${hostname}`,
      reason: `DNS lookup failed for ${hostname}: ${message}`,
    };
  }

  if (addresses.length === 0) {
    return {
      ok: false,
      statusCode: 502,
      clientMessage: `Bad Gateway: No DNS results for ${hostname}`,
      reason: `DNS lookup returned no addresses for ${hostname}`,
    };
  }

  const blockedAddress = addresses.find((addr) =>
    isBlockedIpAddress(addr.address)
  );
  if (blockedAddress) {
    return {
      ok: false,
      statusCode: 403,
      clientMessage: `403 Forbidden - Target resolves to local/private IP: ${hostname}`,
      reason: `${hostname} resolved to blocked IP ${blockedAddress.address}`,
    };
  }

  // Return the exact IP we validated. Callers connect to this address, never
  // re-resolving the hostname — a resolver that flips between a public and an
  // internal answer (DNS rebinding) therefore can't slip past the blocklist.
  return { ok: true, resolvedIp: addresses[0]?.address };
}

/**
 * Extract deployment name and token from Proxy-Authorization Basic auth header.
 * Workers send: HTTP_PROXY=http://<deploymentName>:<token>@gateway:8118
 * This creates a Basic auth header with username=deploymentName, password=token
 */
function extractProxyCredentials(
  req: http.IncomingMessage
): ProxyCredentials | null {
  const authHeader = req.headers["proxy-authorization"];
  if (!authHeader || typeof authHeader !== "string") {
    return null;
  }

  // Parse Basic auth: "Basic base64(username:password)"
  const match = authHeader.match(/^Basic\s+(.+)$/i);
  if (!match?.[1]) {
    return null;
  }

  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf-8");
    const colonIndex = decoded.indexOf(":");
    if (colonIndex === -1) {
      return null;
    }
    const deploymentName = decoded.substring(0, colonIndex);
    const token = decoded.substring(colonIndex + 1);
    if (!deploymentName || !token) {
      return null;
    }
    return { deploymentName, token };
  } catch {
    return null;
  }
}

interface ValidatedProxy {
  deploymentName: string;
  tokenData: WorkerTokenData;
}

/**
 * Validate proxy authentication by verifying the encrypted worker token
 * and cross-checking the claimed deployment name.
 *
 * Revocation is checked against the synchronous in-memory cache only, so the DB
 * never blocks egress. Under N>1 replicas a token revoked on pod A is initially
 * invisible to pod B's cache; on a cache miss we fire a background DB refresh
 * (fire-and-forget) that pulls the revoke into the cache, so the next request
 * for that jti is denied — closing the cross-pod gap within one request rather
 * than waiting out the cache TTL.
 */
async function validateProxyAuth(
  req: http.IncomingMessage
): Promise<ValidatedProxy | null> {
  const creds = extractProxyCredentials(req);
  if (!creds) {
    return null;
  }

  const tokenData = verifyWorkerToken(creds.token);
  if (!tokenData) {
    logger.warn(
      `Proxy auth failed: invalid token (claimed deployment: ${creds.deploymentName})`
    );
    return null;
  }

  // Revocation check. The hot path is the synchronous in-memory cache so a
  // slow/unavailable DB never blocks egress. On a cache miss we allow this
  // request (the pre-existing behavior) but kick off a background DB refresh, so
  // a jti revoked on ANOTHER replica is pulled into this pod's cache and denied
  // on the next request — closing the cross-pod gap within one request instead of
  // waiting out the cache TTL (or the token's lifetime). `isRevoked` fails open
  // on a DB error and swallows its own rejections.
  if (tokenData.jti) {
    const store = getProxyRevokedTokenStore();
    if (store.isRevokedCached(tokenData.jti)) {
      logger.warn(
        `Proxy auth failed: revoked jti (claimed deployment: ${creds.deploymentName})`
      );
      return null;
    }
    void store.isRevoked(tokenData.jti).catch(() => {});
  }

  const deploymentMatch = constantTimeEqual(
    tokenData.deploymentName,
    creds.deploymentName
  );
  if (!deploymentMatch) {
    logger.warn(
      `Proxy auth failed: deployment mismatch (claimed: ${creds.deploymentName}, token: ${tokenData.deploymentName})`
    );
    return null;
  }

  return { deploymentName: creds.deploymentName, tokenData };
}

/**
 * Check if a hostname matches any domain patterns
 * Supports exact matches and wildcard patterns (.example.com matches *.example.com)
 */
/**
 * Canonicalize a hostname for allow/deny/judge matching. WHATWG URL parsing and
 * the CONNECT host parser both preserve a trailing dot (`evil.com.`), which DNS
 * resolves identically to `evil.com` but which configured allow/deny/judge
 * patterns never carry. Without stripping it, a trailing-dot host slips past the
 * blocklist in unrestricted+blocklist mode (matches neither the exact nor the
 * `.suffix` pattern) while the plain form is blocked. Strip trailing dots so
 * every matcher sees the same name DNS will ultimately resolve.
 *
 * It also IDNA/punycode-normalizes the host. The HTTP path derives the host
 * from `new URL().hostname` (already `xn--` ASCII), but the CONNECT path's raw
 * parser returns the host verbatim (possibly Unicode). Configured allow/deny
 * patterns are stored as punycode (see `normalizeDomainPattern`), so a Unicode
 * CONNECT host would otherwise never match its punycode blocklist entry (and
 * CONNECT vs HTTP would disagree for the same IDN host). Routing both through
 * `domainToASCII` makes every matcher see the one canonical ASCII name.
 */
function canonicalizeHostname(hostname: string): string {
  const stripped = hostname.replace(/\.+$/, "");
  const ascii = domainToASCII(stripped);
  return (ascii !== "" ? ascii : stripped).toLowerCase();
}

function matchesDomainPattern(hostname: string, patterns: string[]): boolean {
  const lowerHostname = hostname.toLowerCase();

  for (const pattern of patterns) {
    const lowerPattern = pattern.toLowerCase();

    if (lowerPattern.startsWith(".")) {
      // Wildcard pattern: .example.com matches *.example.com
      const domain = lowerPattern.substring(1);
      if (lowerHostname === domain || lowerHostname.endsWith(`.${domain}`)) {
        return true;
      }
    } else if (lowerPattern === lowerHostname) {
      // Exact match
      return true;
    }
  }

  return false;
}

/**
 * Check if a hostname is allowed based on allowlist/blocklist configuration.
 * Rules:
 * - deniedDomains are checked first (take precedence)
 * - allowedDomains are checked second
 * - If allowedDomains contains "*", unrestricted mode is enabled
 * - If allowedDomains is empty, complete isolation (deny all)
 */
function isHostnameAllowed(
  hostname: string,
  allowedDomains: string[],
  deniedDomains: string[]
): boolean {
  // Unrestricted mode - allow all except explicitly disallowed
  if (isUnrestrictedMode(allowedDomains)) {
    if (deniedDomains.length === 0) {
      return true; // No blocklist, allow all
    }
    return !matchesDomainPattern(hostname, deniedDomains);
  }

  // Complete isolation mode - deny all
  if (allowedDomains.length === 0) {
    return false;
  }

  // Allowlist mode - check if allowed
  const isAllowed = matchesDomainPattern(hostname, allowedDomains);

  // Even if allowed, check blocklist
  if (isAllowed && deniedDomains.length > 0) {
    return !matchesDomainPattern(hostname, deniedDomains);
  }

  return isAllowed;
}

/**
 * Structured audit log for every access decision. We keep the shape stable
 * (one log record per request) so operators can grep / index on it. We do
 * NOT log request bodies or headers — the proxy is a trust boundary and
 * the audit log must not become a secondary leak surface.
 */
function logAccessDecision(
  method: string,
  hostname: string,
  deploymentName: string,
  agentId: string | undefined,
  decision: AccessDecision
): void {
  // Audit log only fires for non-trivial decisions — every judge
  // invocation and every denial. Globally-allowed fast-path requests are
  // the common case on busy gateways and flooding the log with them turns
  // a useful audit stream into noise (and costs serialization per req).
  if (decision.allowed && decision.source === "global") {
    return;
  }
  logger.info("egress-decision", {
    method,
    hostname,
    deploymentName,
    agentId,
    allowed: decision.allowed,
    source: decision.source,
    ...(decision.judge
      ? {
          judgeName: decision.judge.judgeName,
          judgeVerdict: decision.judge.verdict,
          judgeReason: decision.judge.reason,
          judgeSource: decision.judge.source,
          judgeLatencyMs: decision.judge.latencyMs,
          policyHash: decision.judge.policyHash,
        }
      : {}),
  });
}

/**
 * Strip CR/LF and trim to a safe length so judge-provided reasons can't
 * inject extra HTTP response headers via the status line.
 */
function escapeHeaderValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Extract hostname from CONNECT request
 */
function extractConnectHostname(url: string): string | null {
  // CONNECT requests are in format: "host:port"
  const match = url.match(/^([^:]+):\d+$/);
  return match?.[1] ? match[1] : null;
}

/**
 * Handle HTTPS CONNECT tunneling with per-deployment network config
 */
async function handleConnect(
  config: ResolvedNetworkConfig,
  req: http.IncomingMessage,
  clientSocket: import("stream").Duplex,
  head: Buffer
): Promise<void> {
  const url = req.url || "";
  const hostname = extractConnectHostname(url);

  if (!hostname) {
    logger.warn(`Invalid CONNECT request: ${url}`);
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.end();
    return;
  }

  let targetSocket: net.Socket | null = null;
  clientSocket.on("error", (err) => {
    // Clients commonly reset denied CONNECT tunnels after reading the 4xx
    // response. A Duplex socket with no error listener treats ECONNRESET as
    // process-fatal, so attach this handler before any early-return path can
    // write and close the socket.
    if ((err as NodeJS.ErrnoException).code === "ECONNRESET") {
      logger.debug(`Client disconnected for ${hostname} (ECONNRESET)`);
    } else {
      logger.debug(`Client connection error for ${hostname}: ${err.message}`);
    }
    try {
      targetSocket?.end();
    } catch {
      // Ignore errors while cleaning up an already-closed target socket.
    }
  });
  clientSocket.on("close", () => {
    try {
      targetSocket?.end();
    } catch {
      // Ignore errors while cleaning up an already-closed target socket.
    }
  });

  // Validate worker token
  const auth = await validateProxyAuth(req);
  if (!auth) {
    logger.warn(`Proxy auth required for CONNECT to ${hostname}`);
    try {
      clientSocket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="lobu-proxy"\r\n\r\n'
      );
      clientSocket.end();
    } catch {
      // Client may have already disconnected
    }
    return;
  }

  const { deploymentName, tokenData } = auth;

  // Check domain access: global config → grant store → LLM egress judge.
  // TLS CONNECT tunneling means we cannot see the method or path — the
  // judge decides on hostname alone.
  const decision = await checkDomainAccess(
    config,
    hostname,
    tokenData.agentId,
    tokenData.organizationId,
    {
      conversationId: tokenData.conversationId,
      userId: tokenData.userId,
    }
  );
  logAccessDecision(
    "CONNECT",
    hostname,
    deploymentName,
    tokenData.agentId,
    decision
  );
  if (!decision.allowed) {
    const reason = decision.judge?.reason ?? `Domain not allowed: ${hostname}`;
    logger.warn(
      `Blocked CONNECT to ${hostname} (deployment: ${deploymentName}) - ${reason}`
    );
    try {
      clientSocket.write(
        `HTTP/1.1 403 ${escapeHeaderValue(reason)}\r\nContent-Type: text/plain\r\n\r\n403 Forbidden - ${reason}. Network access is configured via lobu.config.ts, skill configs, or the gateway configuration APIs.\r\n`
      );
      clientSocket.end();
    } catch {
      // Client may have already disconnected
    }
    return;
  }

  const targetResolution = await resolveAndValidateTarget(hostname);
  if (!targetResolution.ok) {
    logger.warn(
      `Blocked CONNECT to ${hostname} (deployment: ${deploymentName}) - ${targetResolution.reason}`
    );
    try {
      clientSocket.write(
        `HTTP/1.1 ${targetResolution.statusCode} ${
          targetResolution.statusCode === 403 ? "Forbidden" : "Bad Gateway"
        }\r\nContent-Type: text/plain\r\n\r\n${targetResolution.clientMessage}\r\n`
      );
      clientSocket.end();
    } catch {
      // Client may have already disconnected
    }
    return;
  }

  const resolvedIp = targetResolution.resolvedIp;
  if (!resolvedIp) {
    clientSocket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    clientSocket.end();
    return;
  }

  logger.debug(`Allowing CONNECT to ${hostname} via ${resolvedIp}`);

  // Parse host and port. The port must be a real integer in 1..65535 —
  // `parseInt(...) || 443` would silently accept "99999" or "0" and hand a
  // bogus value to `net.connect`.
  const [host, portStr] = url.split(":");
  const port = portStr ? Number.parseInt(portStr, 10) : 443;

  if (!host) {
    logger.warn(`Invalid CONNECT host: ${url}`);
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.end();
    return;
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    logger.warn(`Invalid CONNECT port: ${url}`);
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.end();
    return;
  }

  // Establish connection to target
  const tunnelSocket = net.connect(port, resolvedIp, () => {
    // Send success response to client
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    // Pipe the connection bidirectionally
    tunnelSocket.write(head);
    tunnelSocket.pipe(clientSocket);
    clientSocket.pipe(tunnelSocket);
  });
  targetSocket = tunnelSocket;

  tunnelSocket.on("error", (err) => {
    logger.debug(`Target connection error for ${hostname}: ${err.message}`);
    try {
      clientSocket.end();
    } catch {
      // Ignore errors when closing already-closed socket
    }
  });

  // Handle close events to clean up
  tunnelSocket.on("close", () => {
    try {
      clientSocket.end();
    } catch {
      // Ignore
    }
  });
}

/**
 * Handle regular HTTP proxy requests with per-deployment network config
 */
async function handleProxyRequest(
  config: ResolvedNetworkConfig,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const targetUrl = req.url;

  if (!targetUrl) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request: No URL provided\n");
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request: Invalid URL\n");
    return;
  }

  const hostname = parsedUrl.hostname;

  // Validate worker token
  const auth = await validateProxyAuth(req);
  if (!auth) {
    logger.warn(`Proxy auth required for ${req.method} ${hostname}`);
    res.writeHead(407, {
      "Content-Type": "text/plain",
      "Proxy-Authenticate": 'Basic realm="lobu-proxy"',
    });
    res.end("407 Proxy Authentication Required\n");
    return;
  }

  const { deploymentName, tokenData } = auth;

  // Check domain access: global config → grant store → LLM egress judge.
  // Plain HTTP: method and path are visible and are passed through to the
  // judge so policies can reason about specific endpoints.
  const decision = await checkDomainAccess(
    config,
    hostname,
    tokenData.agentId,
    tokenData.organizationId,
    {
      method: req.method,
      path: parsedUrl.pathname + parsedUrl.search,
      conversationId: tokenData.conversationId,
      userId: tokenData.userId,
    }
  );
  logAccessDecision(
    req.method ?? "?",
    hostname,
    deploymentName,
    tokenData.agentId,
    decision
  );
  if (!decision.allowed) {
    const reason = decision.judge?.reason ?? `Domain not allowed: ${hostname}`;
    logger.warn(
      `Blocked request to ${hostname} (deployment: ${deploymentName}) - ${reason}`
    );
    res.writeHead(403, escapeHeaderValue(reason), {
      "Content-Type": "text/plain",
    });
    res.end(
      `403 Forbidden - ${reason}. Network access is configured via lobu.config.ts, skill configs, or the gateway configuration APIs.\n`
    );
    return;
  }

  const targetResolution = await resolveAndValidateTarget(hostname);
  if (!targetResolution.ok) {
    logger.warn(
      `Blocked request to ${hostname} (deployment: ${deploymentName}) - ${targetResolution.reason}`
    );
    res.writeHead(targetResolution.statusCode ?? 502, {
      "Content-Type": "text/plain",
    });
    res.end(`${targetResolution.clientMessage}\n`);
    return;
  }

  const resolvedIp = targetResolution.resolvedIp;
  if (!resolvedIp) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal proxy error\n");
    return;
  }

  logger.debug(
    `Proxying ${req.method} ${hostname}${parsedUrl.pathname} via ${resolvedIp}`
  );

  // Remove proxy-authorization header before forwarding
  const forwardHeaders = { ...req.headers };
  delete forwardHeaders["proxy-authorization"];

  // Forward the request
  const options: http.RequestOptions = {
    hostname: resolvedIp,
    port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: req.method,
    headers: forwardHeaders,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // Redirects (3xx + Location) are forwarded verbatim and NOT followed
    // here. This is a forward proxy: the client sees the 3xx, issues a brand
    // new request for the Location URL, and that request re-enters this proxy
    // and goes through `checkDomainAccess` + `resolveAndValidateTarget`
    // again. So a redirect to an internal address can't bypass the guards —
    // the follow-up request is independently re-validated. (If this code ever
    // grows redirect-following, the redirect target MUST be re-validated.)
    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
    // Stream response body
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    logger.error(`Proxy request error for ${hostname}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad Gateway: Could not reach target server\n");
    } else {
      res.end();
    }
  });

  // Stream request body
  req.pipe(proxyReq);
}

/**
 * Start HTTP proxy server with per-deployment network config support.
 *
 * Workers identify themselves via Proxy-Authorization Basic auth:
 *   HTTP_PROXY=http://<deploymentName>:<token>@gateway:8118
 *
 * The proxy validates the encrypted worker token, cross-checks the
 * claimed deployment name, and looks up per-deployment network config.
 * Returns 407 if authentication fails.
 *
 * @param port - Port to listen on (default 8118)
 * @param host - Bind address (default "::" for all interfaces)
 * @param config - Network allow/deny config for this server. Defaults to a fresh
 *   snapshot resolved from the environment; tests pass one explicitly so the
 *   server's behavior is fully determined by its arguments, not ambient state.
 * @returns Promise that resolves with the server once listening, or rejects on error
 */
export function startHttpProxy(
  port: number = 8118,
  host: string = "::",
  config: ResolvedNetworkConfig = resolveNetworkConfig()
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const global = config;

    const server = http.createServer((req, res) => {
      handleProxyRequest(config, req, res).catch((err) => {
        logger.error("Error handling proxy request:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal proxy error\n");
        }
      });
    });

    // Handle CONNECT method for HTTPS tunneling
    server.on("connect", (req, clientSocket, head) => {
      handleConnect(config, req, clientSocket, head).catch((err) => {
        logger.error("Error handling CONNECT:", err);
        try {
          clientSocket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
          clientSocket.end();
        } catch {
          // Ignore
        }
      });
    });

    server.on("error", (err) => {
      logger.error("HTTP proxy server error:", err);
      reject(err);
    });

    server.listen(port, host, () => {
      // Remove the startup error listener so it doesn't reject later operational errors
      server.removeAllListeners("error");
      server.on("error", (err) => {
        logger.error("HTTP proxy server error:", err);
      });

      let mode: string;
      if (isUnrestrictedMode(global.allowedDomains)) {
        mode = "unrestricted";
      } else if (global.allowedDomains.length > 0) {
        mode = "allowlist";
      } else {
        mode = "complete-isolation";
      }

      logger.debug(
        `HTTP proxy started on ${host}:${port} (mode=${mode}, allowed=${global.allowedDomains.length}, denied=${global.deniedDomains.length})`
      );
      resolve(server);
    });
  });
}

/**
 * Stop HTTP proxy server
 */
export function stopHttpProxy(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        logger.error("Error stopping HTTP proxy:", err);
        reject(err);
      } else {
        logger.info("HTTP proxy stopped");
        resolve();
      }
    });
  });
}
