/**
 * WinterCG Direct Sockets / Cloudflare Sockets standard API for Lobu connectors.
 *
 * Exposes TCP connection primitives to pure-JS V8 isolates without requiring
 * `node:net` or `node:tls`. The isolate prelude installs `globalThis.connect`
 * (and answers `require('cloudflare:sockets')` with the same function), so the
 * guest never opens a socket itself: the HOST dials, after resolving the name
 * and applying the DB egress policy (`LOBU_DB_EGRESS_POLICY` /
 * `LOBU_DB_EGRESS_ALLOW_HOSTS`) to the resolved addresses.
 *
 * Nothing installs `connect` outside that runtime — a Cloudflare Worker would
 * have to import `cloudflare:sockets` itself — so calling this anywhere else
 * throws rather than silently opening a raw socket.
 */

export interface SocketAddress {
  hostname: string;
  port: number;
}

export interface SocketOptions {
  secureTransport?: 'off' | 'on' | 'starttls';
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
 * Connect to a TCP or TLS endpoint using the standard WinterCG Direct Sockets
 * API. Delegates to `globalThis.connect` when the runtime installs one.
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
