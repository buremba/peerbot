/**
 * WinterCG Direct Sockets / Cloudflare Sockets standard API for Lobu connectors.
 *
 * Exposes TCP connection primitives to pure-JS V8 isolates without requiring
 * node:net or node:tls. In Cloudflare Workers this wraps \`cloudflare:sockets\`;
 * in Lobu's worker runtime it connects over the host capability bridge with
 * full SSRF protection (private IP blocking + DNS resolution pinning).
 */

export interface SocketAddress {
  hostname: string;
  port: number;
}

export interface SocketOptions {
  secureTransport?: 'off' | 'on' | 'starttls';
  allowHalfOpen?: boolean;
}

export interface SocketInfo {
  remoteAddress: string;
  localAddress?: string;
}

export interface Socket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly closed: Promise<void>;
  close(): Promise<void>;
  startTls(): Socket;
}

export interface ConnectFn {
  (address: string | SocketAddress, options?: SocketOptions): Socket;
}

declare global {
  var connect: ConnectFn | undefined;
}

/**
 * Connect to a TCP or TLS endpoint using the standard WinterCG Direct Sockets API.
 * Delegates to \`globalThis.connect\` if available in the isolate runtime.
 */
export function connect(address: string | SocketAddress, options?: SocketOptions): Socket {
  if (typeof globalThis.connect === 'function') {
    return globalThis.connect(address, options);
  }
  throw new Error(
    'WinterCG connect() is not available in this execution environment. ' +
      'Ensure the connector is running on an isolate runtime with network capabilities enabled.'
  );
}
