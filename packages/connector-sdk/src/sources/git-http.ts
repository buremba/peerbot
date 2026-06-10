/**
 * HttpClient for isomorphic-git that:
 *
 *  - Talks https only — refuses to issue any request whose URL is not
 *    `https://...`.
 *  - Follows redirects manually (max 5 hops). Every `Location` is re-validated
 *    https before the next request — closes the https-to-http downgrade hole
 *    that an https endpoint replying with `Location: http://...` would
 *    otherwise open against the default `isomorphic-git/http/node` impl
 *    (which uses `simple-get`'s built-in redirect follower and does NOT
 *    enforce a scheme on the next hop).
 *
 * Implemented on top of Node's `https.request` so the SDK doesn't pull in
 * an extra HTTP client. The body-as-async-iterator contract matches
 * isomorphic-git's `GitHttpRequest` / `GitHttpResponse` types.
 */

import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';

interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: AsyncIterable<Uint8Array> | Uint8Array | Buffer;
}

interface GitHttpResponse {
  url: string;
  method: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: AsyncIterableIterator<Uint8Array>;
}

const MAX_REDIRECTS = 5;

async function bodyToBuffer(
  body: AsyncIterable<Uint8Array> | Uint8Array | Buffer | undefined,
): Promise<Buffer | undefined> {
  if (!body) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function flattenHeaders(raw: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function nodeStreamToAsyncIterableIterator(
  stream: IncomingMessage,
): AsyncIterableIterator<Uint8Array> {
  // IncomingMessage is already AsyncIterable<Buffer>. Wrap it as an
  // AsyncIterableIterator since that's what isomorphic-git's type
  // demands (it has a `next()` method).
  const iter = stream[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
  return {
    next: () => iter.next(),
    return: iter.return ? (v) => iter.return!(v) : undefined,
    throw: iter.throw ? (e) => iter.throw!(e) : undefined,
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

async function singleRequest(req: GitHttpRequest): Promise<{
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  bodyStream: IncomingMessage;
  url: string;
}> {
  if (!req.url.startsWith('https://')) {
    throw new Error(`GitFileSource: refusing non-https request: ${req.url}`);
  }
  const parsed = new URL(req.url);
  const bodyBuf = await bodyToBuffer(req.body);
  const method = (req.method ?? 'GET').toUpperCase();
  const headers: Record<string, string | number> = { ...(req.headers ?? {}) };
  if (bodyBuf) {
    headers['content-length'] = bodyBuf.length;
  }

  return new Promise((resolve, reject) => {
    const r = httpsRequest(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
      },
      (res) => {
        resolve({
          statusCode: res.statusCode ?? 0,
          statusMessage: res.statusMessage ?? '',
          headers: flattenHeaders(res.headers),
          bodyStream: res,
          url: req.url,
        });
      },
    );
    r.on('error', reject);
    if (bodyBuf) r.write(bodyBuf);
    r.end();
  });
}

async function drain(stream: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    stream.on('data', () => undefined);
    stream.on('end', () => resolve());
    stream.on('error', () => resolve());
    stream.resume();
  });
}

/**
 * Send `req`, manually following 3xx redirects up to MAX_REDIRECTS. Every
 * hop validates the next URL is https. On a 30x→non-https Location, throws.
 *
 * Per RFC 7231 §6.4: 301/302/303 turn POST into GET and drop the request
 * body; 307/308 preserve the method and body. isomorphic-git's traffic is
 * GET (info/refs) and POST (upload-pack / receive-pack). For a POST that
 * gets redirected with a method-changing status we drop the body — git
 * smart servers don't typically issue method-changing redirects mid-flow,
 * but if they did, the resulting GET would surface as a server-side error
 * rather than silently completing.
 */
export async function gitHttpRequest(req: GitHttpRequest): Promise<GitHttpResponse> {
  let cur: GitHttpRequest = req;
  let lastBuffered: Buffer | undefined;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (cur.body && !Buffer.isBuffer(cur.body) && !(cur.body instanceof Uint8Array)) {
      // Eagerly buffer the body so a redirect can replay it without
      // re-consuming an already-iterated source.
      lastBuffered = await bodyToBuffer(cur.body);
      cur = { ...cur, body: lastBuffered };
    }
    const res = await singleRequest(cur);
    const status = res.statusCode;
    const isRedirect = status >= 300 && status < 400 && res.headers['location'];
    if (!isRedirect) {
      return {
        url: res.url,
        method: cur.method ?? 'GET',
        statusCode: status,
        statusMessage: res.statusMessage,
        headers: res.headers,
        body: nodeStreamToAsyncIterableIterator(res.bodyStream),
      };
    }
    const locHeader = res.headers['location'];
    if (!locHeader) {
      return {
        url: res.url,
        method: cur.method ?? 'GET',
        statusCode: status,
        statusMessage: res.statusMessage,
        headers: res.headers,
        body: nodeStreamToAsyncIterableIterator(res.bodyStream),
      };
    }
    let nextUrl: string;
    try {
      nextUrl = new URL(locHeader, cur.url).toString();
    } catch {
      throw new Error(`GitFileSource: invalid redirect location: ${locHeader}`);
    }
    if (!nextUrl.startsWith('https://')) {
      throw new Error(
        `GitFileSource: redirect to plaintext URL rejected: ${nextUrl}`,
      );
    }
    // Drain the redirect's body so the socket can be reused.
    await drain(res.bodyStream);

    // RFC 7231 §6.4.2/6.4.3: 301/302/303 strip the body and change the
    // method to GET. 307/308 preserve method + body.
    let nextMethod = cur.method ?? 'GET';
    let nextBody: Buffer | undefined = lastBuffered;
    if (status === 301 || status === 302 || status === 303) {
      if (nextMethod !== 'GET' && nextMethod !== 'HEAD') {
        nextMethod = 'GET';
        nextBody = undefined;
      }
    }
    cur = {
      url: nextUrl,
      method: nextMethod,
      headers: { ...(cur.headers ?? {}) },
      body: nextBody,
    };
  }
  throw new Error(`GitFileSource: too many redirects (>${MAX_REDIRECTS}) for ${req.url}`);
}

export const gitHttpsOnlyClient = { request: gitHttpRequest };
