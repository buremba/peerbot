import crypto from "node:crypto";
import type { LookupAddress } from "node:dns";
import * as dns from "node:dns/promises";
import * as http from "node:http";
import * as net from "node:net";
import { URL } from "node:url";
import type { WorkerTokenData } from "@lobu/core";
import { createLogger, verifyWorkerToken } from "@lobu/core";
import {
  isUnrestrictedMode,
  loadAllowedDomains,
  loadDisallowedDomains,
} from "../config/network-allowlist.js";
import type { GrantStore } from "../permissions/grant-store.js";
import type { PolicyStore } from "../permissions/policy-store.js";
import { EgressJudge } from "./egress-judge/judge.js";
import type { JudgeDecision } from "./egress-judge/types.js";

const logger = createLogger("http-proxy");

interface ResolvedNetworkConfig {
  allowedDomains: string[];
  deniedDomains: string[];
}

interface TargetResolutionResult {
  ok: boolean;
  resolvedIp?: string;
  statusCode?: number;
  clientMessage?: string;
  reason?: string;
}

const blockedIpv4Ranges: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const blockedIpv6Ranges: ReadonlyArray<readonly [string, number]> = [
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

const blockedIpv4List = new net.BlockList();
for (const [address, prefix] of blockedIpv4Ranges) {
  blockedIpv4List.addSubnet(address, prefix, "ipv4");
}

const blockedIpv6List = new net.BlockList();
blockedIpv6List.addAddress("::", "ipv6");
blockedIpv6List.addAddress("::1", "ipv6");
for (const [address, prefix] of blockedIpv6Ranges) {
  blockedIpv6List.addSubnet(address, prefix, "ipv6");
}

// Cache for global defaults (used when no deployment identified)
let globalConfig: ResolvedNetworkConfig | null = null;

// Module-level grant store reference for domain grant checks
let proxyGrantStore: GrantStore | null = null;

// Module-level policy store + lazy egress judge. The judge is only used
// when a request matches a `judgedDomains` rule — most traffic never
// touches it.
let proxyPolicyStore: PolicyStore | null = null;
let proxyEgressJudge: EgressJudge | null = null;

/**
 * Set the grant store for the HTTP proxy to check domain grants.
 * Called during gateway initialization.
 */
export function setProxyGrantStore(store: GrantStore): void {
  proxyGrantStore = store;
}

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
 * Replace the lazy {@link EgressJudge} — tests inject a fake client here
 * so the proxy can be exercised end-to-end without hitting a real model.
 */
export function setProxyEgressJudge(judge: EgressJudge): void {
  proxyEgressJudge = judge;
}

function getGlobalConfig(): ResolvedNetworkConfig {
  if (!globalConfig) {
    // Pre-lowercase the env-driven pattern lists once so the per-request
    // matcher doesn't re-lowercase every pattern on every outbound request.
    globalConfig = {
      allowedDomains: loadAllowedDomains().map((d) => d.toLowerCase()),
      deniedDomains: loadDisallowedDomains().map((d) => d.toLowerCase()),
    };
  }
  return globalConfig;
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
  hostname: string,
  agentId: string | undefined,
  requestContext?: { method?: string; path?: string }
): Promise<AccessDecision> {
  const global = getGlobalConfig();

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
    // Even if globally allowed, a per-agent deny grant can override
    if (proxyGrantStore && agentId) {
      const denied = await proxyGrantStore.isDenied(agentId, hostname);
      if (denied) {
        logger.debug(`Domain ${hostname} denied via grant (agent: ${agentId})`);
        return { allowed: false, source: "grant" };
      }
    }
    return { allowed: true, source: "global" };
  }

  // Not globally allowed — check grant store for per-agent access
  if (proxyGrantStore && agentId) {
    const granted = await proxyGrantStore.hasGrant(agentId, hostname);
    if (granted) {
      logger.debug(`Domain ${hostname} allowed via grant (agent: ${agentId})`);
      return { allowed: true, source: "grant" };
    }
  }

  // Fall through to the LLM egress judge when a matching rule exists.
  if (proxyPolicyStore && proxyEgressJudge && agentId) {
    const rule = proxyPolicyStore.resolve(agentId, hostname);
    if (rule) {
      const decision = await proxyEgressJudge.decide(
        {
          agentId,
          hostname,
          method: requestContext?.method,
          path: requestContext?.path,
        },
        rule
      );
      return {
        allowed: decision.verdict === "allow",
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

/**
 * Result of running a host literal through {@link normalizeIpLiteral}.
 *  - `ipv4`     — the value is (or decodes to) a bare IPv4 address.
 *  - `ipv6`     — a genuine IPv6 address that doesn't embed an IPv4.
 *  - `not-ip`   — not an IP literal at all (a DNS name); caller should resolve.
 *  - `invalid`  — looks like an IP literal but doesn't cleanly parse → reject.
 */
type NormalizedHost =
  | { kind: "ipv4"; value: string }
  | { kind: "ipv6"; value: string }
  | { kind: "not-ip" }
  | { kind: "invalid" };

/** Turn 16 bits + 16 bits into a dotted-quad IPv4 string. */
function hextetsToIpv4(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/**
 * Expand a valid IPv6 address string into exactly 8 unsigned 16-bit hextets.
 * Handles `::` compression and mixed dotted-quad suffixes (e.g. `::ffff:127.0.0.1`).
 * The caller must pass a string already validated by `net.isIP() === 6`.
 */
function expandIpv6ToHextets(addr: string): number[] {
  const lower = addr.toLowerCase();

  // Detect and handle the embedded IPv4 dotted-quad suffix (e.g. `::ffff:127.0.0.1`).
  // RFC 4291 §2.2 allows the last 32 bits of an IPv6 address to be written in
  // dotted-quad form. When present, convert those 4 octets to 2 hextets first.
  let hexPart = lower;
  let ipv4Suffix: number[] = [];
  const dotIdx = lower.lastIndexOf(".");
  if (dotIdx !== -1) {
    // The dotted-quad portion starts at the last ':' before the first dot.
    const colonBeforeDot = lower.lastIndexOf(":", dotIdx);
    const dotted = lower.slice(colonBeforeDot + 1);
    hexPart = lower.slice(0, colonBeforeDot + 1); // keep the trailing ':'
    const octets = dotted.split(".").map((o) => parseInt(o, 10));
    // octets must be exactly 4 valid bytes (already guaranteed by net.isIP)
    ipv4Suffix = [
      ((octets[0]! << 8) | octets[1]!) >>> 0,
      ((octets[2]! << 8) | octets[3]!) >>> 0,
    ];
    // Strip the trailing colon we left on hexPart so split works correctly
    if (hexPart.endsWith(":") && !hexPart.endsWith("::")) {
      hexPart = hexPart.slice(0, -1);
    }
  }

  const halves = hexPart.split("::");
  const left = halves[0] ? halves[0].split(":").map((h) => parseInt(h, 16)) : [];
  const right =
    halves.length === 2 && halves[1]
      ? halves[1].split(":").map((h) => parseInt(h, 16))
      : [];
  const rightWithSuffix = [...right, ...ipv4Suffix];
  const zeros = new Array(8 - left.length - rightWithSuffix.length).fill(0);
  return [...left, ...zeros, ...rightWithSuffix];
}

/**
 * Single funnel for every host literal that reaches the blocklist check —
 * resolved DNS results and CONNECT/forward targets alike. Collapses the
 * forms an attacker can use to dress up an internal address as something
 * `net.BlockList` won't recognise:
 *   - IPv4-mapped IPv6, dotted (`::ffff:127.0.0.1`) and hex (`::ffff:7f00:1`)
 *   - NAT64 well-known prefix `64:ff9b::/96` (last 32 bits are an IPv4)
 *   - zone IDs (`fe80::1%eth0` → strip `%eth0`)
 *   - compressed / uppercase forms (handled by `net.isIP`)
 * Anything that looks like an IP but doesn't parse returns `invalid` so the
 * caller fails closed rather than falling through to a DNS lookup.
 */
function normalizeIpLiteral(host: string): NormalizedHost {
  // Strip a zone identifier first (`%eth0`, `%1`). It's only meaningful for
  // link-local addresses and never changes the routability decision.
  const zoneSplit = host.indexOf("%");
  const bare = (zoneSplit === -1 ? host : host.slice(0, zoneSplit)).trim();
  if (bare.length === 0) {
    return zoneSplit === -1 ? { kind: "not-ip" } : { kind: "invalid" };
  }

  const family = net.isIP(bare);
  if (family === 4) {
    return { kind: "ipv4", value: bare };
  }
  if (family === 0) {
    // Not a valid IP literal. If it contains ':' it was meant to be an IPv6
    // address (or something pretending to be one) but didn't parse — reject.
    // Otherwise treat it as a hostname for the caller to resolve.
    return bare.includes(":") ? { kind: "invalid" } : { kind: "not-ip" };
  }

  // family === 6 from here on.
  const lower = bare.toLowerCase();

  // IPv4-mapped IPv6: `::ffff:a.b.c.d` or `::ffff:hhhh:hhhh`.
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    if (mapped.includes(".")) {
      return net.isIP(mapped) === 4
        ? { kind: "ipv4", value: mapped }
        : { kind: "invalid" };
    }
    const parts = mapped.split(":");
    if (parts.length !== 2) {
      return { kind: "invalid" };
    }
    const high = Number.parseInt(parts[0] || "", 16);
    const low = Number.parseInt(parts[1] || "", 16);
    if (
      !Number.isInteger(high) ||
      !Number.isInteger(low) ||
      high < 0 ||
      high > 0xffff ||
      low < 0 ||
      low > 0xffff
    ) {
      return { kind: "invalid" };
    }
    return { kind: "ipv4", value: hextetsToIpv4(high, low) };
  }

  // NAT64 well-known prefix `64:ff9b::/96` — the trailing 32 bits hold the
  // synthesised IPv4 destination. Both compressed (`64:ff9b::a9fe:a9fe`) and
  // expanded (`64:ff9b:0:0:0:0:a9fe:a9fe`) spellings must decode identically.
  // Canonicalize into 8 hextets and verify the first 96 bits match the prefix.
  const hextets = expandIpv6ToHextets(bare);
  if (
    hextets[0] === 0x0064 &&
    hextets[1] === 0xff9b &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0
  ) {
    return { kind: "ipv4", value: hextetsToIpv4(hextets[6]!, hextets[7]!) };
  }

  return { kind: "ipv6", value: bare };
}

function isBlockedIpAddress(ip: string): boolean {
  const normalized = normalizeIpLiteral(ip);
  switch (normalized.kind) {
    case "ipv4":
      return blockedIpv4List.check(normalized.value, "ipv4");
    case "ipv6":
      // A genuine IPv6 address can still wrap an internal target via a
      // mapped/translation prefix `net.BlockList` doesn't know about; the
      // normalization above handles the standard ones (::ffff:, 64:ff9b::),
      // so by this point a bare IPv6 only needs the IPv6 blocklist.
      return blockedIpv6List.check(normalized.value, "ipv6");
    case "invalid":
      // Fail closed: an address that looks like an IP literal but won't
      // parse cleanly must not be allowed through.
      return true;
    case "not-ip":
      return false;
  }
}

type DnsLookupAllFn = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<LookupAddress[]>;

let dnsLookupOverride: DnsLookupAllFn | null = null;

export const __testOnly = {
  isBlockedIpAddress,
  /** Reset cached global config + module-level stores so tests can rebuild them. */
  reset: () => {
    globalConfig = null;
    proxyGrantStore = null;
    proxyPolicyStore = null;
    proxyEgressJudge = null;
    dnsLookupOverride = null;
  },
  setDnsLookup(fn: DnsLookupAllFn | null): void {
    dnsLookupOverride = fn;
  },
};

/**
 * Strip surrounding brackets from an IPv6 literal so `net.isIP()` can
 * recognise it. WHATWG URL parsing returns `parsedUrl.hostname` with
 * brackets for IPv6 (e.g. `[::1]`), and `net.isIP("[::1]")` returns 0,
 * which would cause the IP-blocklist check to be skipped and the value
 * to fall through to DNS lookup — bypassing the loopback/private-IP
 * guards. Normalising to the bare address closes that hole.
 */
function stripIpv6Brackets(host: string): string {
  if (host.length >= 2 && host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

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
 */
function validateProxyAuth(req: http.IncomingMessage): ValidatedProxy | null {
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

  const deploymentMatch =
    tokenData.deploymentName.length === creds.deploymentName.length &&
    crypto.timingSafeEqual(
      Buffer.from(tokenData.deploymentName),
      Buffer.from(creds.deploymentName)
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
  const auth = validateProxyAuth(req);
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
  const decision = await checkDomainAccess(hostname, tokenData.agentId);
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
        `HTTP/1.1 403 ${escapeHeaderValue(reason)}\r\nContent-Type: text/plain\r\n\r\n403 Forbidden - ${reason}. Network access is configured via lobu.toml, skill configs, or the gateway configuration APIs.\r\n`
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
  const auth = validateProxyAuth(req);
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
  const decision = await checkDomainAccess(hostname, tokenData.agentId, {
    method: req.method,
    path: parsedUrl.pathname + parsedUrl.search,
  });
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
      `403 Forbidden - ${reason}. Network access is configured via lobu.toml, skill configs, or the gateway configuration APIs.\n`
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
 * @returns Promise that resolves with the server once listening, or rejects on error
 */
export function startHttpProxy(
  port: number = 8118,
  host: string = "::"
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const global = getGlobalConfig();

    const server = http.createServer((req, res) => {
      handleProxyRequest(req, res).catch((err) => {
        logger.error("Error handling proxy request:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal proxy error\n");
        }
      });
    });

    // Handle CONNECT method for HTTPS tunneling
    server.on("connect", (req, clientSocket, head) => {
      handleConnect(req, clientSocket, head).catch((err) => {
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
