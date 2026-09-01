import dns from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialService } from '../../auth/credentials';
import {
  CONNECTOR_OAUTH_REQUEST_TIMEOUT_MS,
  MAX_CONNECTOR_OAUTH_RESPONSE_BYTES,
} from '../../utils/connector-oauth-http';
import { exchangeCodeForTokens, fetchUserInfoWithRaw } from '../oauth-providers';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function cancellableBody(...chunks: Uint8Array[]) {
  let cancelled = false;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, wasCancelled: () => cancelled };
}

function exchange(tokenUrl: string) {
  return exchangeCodeForTokens({
    provider: 'connector-oauth',
    code: 'authorization-code',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://lobu.example/connect/oauth/callback',
    tokenUrl,
  });
}

describe('connector OAuth credential-request egress', () => {
  it('blocks literal-private token, refresh, and userinfo endpoints', async () => {
    const networkFetch = vi.fn(async () => {
      throw new Error('private target reached global fetch');
    });
    globalThis.fetch = networkFetch as typeof fetch;

    await expect(exchange('https://127.0.0.1/token')).resolves.toBeNull();

    const credentials = new CredentialService({} as never);
    await expect(
      credentials.refreshTokenGeneric({
        tokenUrl: 'https://169.254.169.254/token',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
      })
    ).resolves.toBeNull();

    await expect(
      fetchUserInfoWithRaw({
        provider: 'connector-oauth',
        accessToken: 'access-token',
        userinfoUrl: 'https://[::1]/userinfo',
      })
    ).resolves.toEqual({ raw: null, normalized: null });
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it('refuses plaintext HTTP before token, refresh, or userinfo credentials reach fetch', async () => {
    const networkFetch = vi.fn(async () => {
      throw new Error('plaintext credential request reached global fetch');
    });
    globalThis.fetch = networkFetch as typeof fetch;

    await expect(exchange('http://oauth.example.com/token')).resolves.toBeNull();

    const credentials = new CredentialService({} as never);
    await expect(
      credentials.refreshTokenGeneric({
        tokenUrl: 'http://oauth.example.com/refresh',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
      })
    ).resolves.toBeNull();

    await expect(
      fetchUserInfoWithRaw({
        provider: 'connector-oauth',
        accessToken: 'access-token',
        userinfoUrl: 'http://oauth.example.com/userinfo',
      })
    ).resolves.toEqual({ raw: null, normalized: null });
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it('fails closed when a token hostname has mixed public/private DNS answers', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] as Awaited<ReturnType<typeof dns.lookup>>);

    await expect(exchange('https://mixed-oauth.example/token')).resolves.toBeNull();
  });

  it('sets redirect:error on every request that carries OAuth credentials', async () => {
    const redirects: Array<RequestRedirect | undefined> = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      redirects.push(init?.redirect);
      return new Response(null, { status: 307, headers: { location: 'http://127.0.0.1/' } });
    }) as typeof fetch;

    await exchange('https://oauth-public.example/token');
    await fetchUserInfoWithRaw({
      provider: 'connector-oauth',
      accessToken: 'access-token',
      userinfoUrl: 'https://oauth-public.example/userinfo',
    });
    const credentials = new CredentialService({} as never);
    await credentials.refreshTokenGeneric({
      tokenUrl: 'https://oauth-public.example/refresh',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
    });

    expect(redirects).toEqual(['error', 'error', 'error']);
  });

  it('cancels an unsuccessful userinfo response body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = vi.fn(async () => new Response(body, { status: 401 })) as typeof fetch;

    await expect(
      fetchUserInfoWithRaw({
        provider: 'connector-oauth',
        accessToken: 'access-token',
        userinfoUrl: 'https://oauth-userinfo.example/me',
      })
    ).resolves.toEqual({ raw: null, normalized: null });
    expect(cancelled).toBe(true);
  });

  it('rejects and cancels a declared oversized token response', async () => {
    const oversized = cancellableBody();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(oversized.body, {
          status: 200,
          headers: { 'content-length': String(MAX_CONNECTOR_OAUTH_RESPONSE_BYTES + 1) },
        })
    ) as typeof fetch;

    await expect(exchange('https://oauth-token.example/token')).resolves.toBeNull();
    expect(oversized.wasCancelled()).toBe(true);
  });

  it('rejects and cancels a chunked oversized userinfo response', async () => {
    const oversized = cancellableBody(
      new Uint8Array(MAX_CONNECTOR_OAUTH_RESPONSE_BYTES),
      new Uint8Array(1)
    );
    globalThis.fetch = vi.fn(async () => new Response(oversized.body)) as typeof fetch;

    await expect(
      fetchUserInfoWithRaw({
        provider: 'connector-oauth',
        accessToken: 'access-token',
        userinfoUrl: 'https://oauth-userinfo.example/me',
      })
    ).resolves.toEqual({ raw: null, normalized: null });
    expect(oversized.wasCancelled()).toBe(true);
  });

  it('aborts a credential request at the shared OAuth deadline', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        })
    ) as typeof fetch;

    const result = exchange('https://oauth-timeout.example/token');
    await vi.advanceTimersByTimeAsync(CONNECTOR_OAUTH_REQUEST_TIMEOUT_MS);
    await expect(result).resolves.toBeNull();
  });
});
