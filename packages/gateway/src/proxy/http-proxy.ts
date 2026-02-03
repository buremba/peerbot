import * as http from "node:http";
import * as net from "node:net";
import { URL } from "node:url";
import { createLogger } from "@peerbot/core";
import {
  isUnrestrictedMode,
  loadAllowedDomains,
  loadDisallowedDomains,
} from "../config/network-allowlist";
import {
  networkConfigStore,
  type ResolvedNetworkConfig,
} from "./network-config-store";

const logger = createLogger("http-proxy");

// Cache for global defaults (used when no deployment identified)
let globalConfig: ResolvedNetworkConfig | null = null;

/**
 * Get global network config (lazy loaded)
 */
function getGlobalConfig(): ResolvedNetworkConfig {
  if (!globalConfig) {
    globalConfig = {
      allowedDomains: loadAllowedDomains(),
      deniedDomains: loadDisallowedDomains(),
    };
  }
  return globalConfig;
}

/**
 * Extract deployment name from Proxy-Authorization Basic auth header.
 * Workers send: HTTP_PROXY=http://<deploymentName>:<token>@gateway:8118
 * This creates a Basic auth header with username=deploymentName
 *
 * @param req - HTTP request
 * @returns Deployment name or null if not present
 */
function extractDeploymentName(req: http.IncomingMessage): string | null {
  const authHeader = req.headers["proxy-authorization"];
  if (!authHeader || typeof authHeader !== "string") {
    return null;
  }

  // Parse Basic auth: "Basic base64(username:password)"
  const match = authHeader.match(/^Basic\s+(.+)$/i);
  if (!match || !match[1]) {
    return null;
  }

  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf-8");
    const colonIndex = decoded.indexOf(":");
    if (colonIndex === -1) {
      return null;
    }
    // Username is the deployment name
    const deploymentName = decoded.substring(0, colonIndex);
    return deploymentName || null;
  } catch {
    return null;
  }
}

/**
 * Get network config for a request.
 * Extracts deployment name from proxy auth and looks up config.
 * Falls back to global config if no deployment identified.
 *
 * @param req - HTTP request
 * @returns Network configuration to apply
 */
async function getNetworkConfigForRequest(
  req: http.IncomingMessage
): Promise<ResolvedNetworkConfig> {
  const deploymentName = extractDeploymentName(req);

  if (deploymentName) {
    // Look up per-deployment config
    return networkConfigStore.get(deploymentName);
  }

  // Fall back to global config
  return getGlobalConfig();
}

/**
 * Check if a hostname matches any domain patterns
 * Supports exact matches and wildcard patterns (.example.com matches *.example.com)
 */
export function matchesDomainPattern(
  hostname: string,
  patterns: string[]
): boolean {
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
 * Rules (sandbox-runtime compatible):
 * - deniedDomains are checked first (take precedence)
 * - allowedDomains are checked second
 * - If allowedDomains contains "*", unrestricted mode is enabled
 * - If allowedDomains is empty, complete isolation (deny all)
 */
export function isHostnameAllowed(
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

  // Get per-deployment or global config
  const config = await getNetworkConfigForRequest(req);
  const deploymentName = extractDeploymentName(req);

  // Check if hostname is allowed
  if (
    !isHostnameAllowed(hostname, config.allowedDomains, config.deniedDomains)
  ) {
    const context = deploymentName ? ` (deployment: ${deploymentName})` : "";
    logger.warn(`Blocked CONNECT to ${hostname}${context}`);
    try {
      clientSocket.write(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nDomain not allowed by proxy policy\r\n"
      );
      clientSocket.end();
    } catch {
      // Client may have already disconnected
    }
    return;
  }

  logger.debug(`Allowing CONNECT to ${hostname}`);

  // Parse host and port
  const [host, portStr] = url.split(":");
  const port = portStr ? parseInt(portStr, 10) || 443 : 443;

  if (!host) {
    logger.warn(`Invalid CONNECT host: ${url}`);
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.end();
    return;
  }

  // Establish connection to target
  const targetSocket = net.connect(port, host, () => {
    // Send success response to client
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    // Pipe the connection bidirectionally
    targetSocket.write(head);
    targetSocket.pipe(clientSocket);
    clientSocket.pipe(targetSocket);
  });

  targetSocket.on("error", (err) => {
    logger.debug(`Target connection error for ${hostname}: ${err.message}`);
    try {
      clientSocket.end();
    } catch {
      // Ignore errors when closing already-closed socket
    }
  });

  clientSocket.on("error", (err) => {
    // ECONNRESET is common when clients drop connections - don't log as error
    if ((err as NodeJS.ErrnoException).code === "ECONNRESET") {
      logger.debug(`Client disconnected for ${hostname} (ECONNRESET)`);
    } else {
      logger.debug(`Client connection error for ${hostname}: ${err.message}`);
    }
    try {
      targetSocket.end();
    } catch {
      // Ignore errors when closing already-closed socket
    }
  });

  // Handle close events to clean up
  targetSocket.on("close", () => {
    try {
      clientSocket.end();
    } catch {
      // Ignore
    }
  });

  clientSocket.on("close", () => {
    try {
      targetSocket.end();
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

  // Get per-deployment or global config
  const config = await getNetworkConfigForRequest(req);
  const deploymentName = extractDeploymentName(req);

  // Check if hostname is allowed
  if (
    !isHostnameAllowed(hostname, config.allowedDomains, config.deniedDomains)
  ) {
    const context = deploymentName ? ` (deployment: ${deploymentName})` : "";
    logger.warn(`Blocked request to ${hostname}${context}`);
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Domain not allowed by proxy policy\n");
    return;
  }

  logger.debug(`Proxying ${req.method} ${hostname}${parsedUrl.pathname}`);

  // Remove proxy-authorization header before forwarding
  const forwardHeaders = { ...req.headers };
  delete forwardHeaders["proxy-authorization"];

  // Forward the request
  const options: http.RequestOptions = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: req.method,
    headers: forwardHeaders,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // Forward response headers
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
 * The proxy extracts deploymentName and looks up the network config
 * from NetworkConfigStore. Falls back to global config if not found.
 */
export function startHttpProxy(port: number = 8118): http.Server {
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
  });

  server.listen(port, "0.0.0.0", () => {
    let mode: string;
    if (isUnrestrictedMode(global.allowedDomains)) {
      mode = "unrestricted";
    } else if (global.allowedDomains.length > 0) {
      mode = "allowlist";
    } else {
      mode = "complete-isolation";
    }

    logger.info(
      `🔒 HTTP proxy started on port ${port} (global: mode=${mode}, allowed=${global.allowedDomains.length}, denied=${global.deniedDomains.length})`
    );
    logger.info(
      `   Per-deployment configs supported via Proxy-Authorization header`
    );
  });

  return server;
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
