/**
 * GitHub installation-token provider contract.
 *
 *  - App JWT: RS256 header, iss/iat/exp claims, exp-iat window <= 600s,
 *    verifiable against the throwaway public key (no real GitHub key needed).
 *  - Token cache: a second mint within the lifetime is served from cache (one
 *    exchange); a token inside the refresh window is re-minted.
 *  - Mint failures: missing App env config, a non-OK exchange (revoked/suspended
 *    install → 404), and a network error all raise InstallationTokenError with
 *    the right `reason`.
 *  - Registry: refuses to mint for a non-active install + an unsupported
 *    provider, and delegates to the registered provider otherwise.
 *
 * The GitHub `/access_tokens` exchange is MOCKED via `fetchImpl` — no request
 * ever reaches api.github.com. Live exchange is the one creds gap (validated by
 * an earlier spike), not covered here.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import type { AppInstallationRow } from "../../../lobu/stores/app-installation-store.js";
import {
  buildGitHubAppJwt,
  GitHubInstallationTokenProvider,
} from "../github-installation-token-provider.js";
import {
  InMemoryInstallationTokenCache,
  InstallationTokenError,
  InstallationTokenRegistry,
  type InstallationTokenProvider,
} from "../installation-token-provider.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function base64urlToJson(seg: string): Record<string, unknown> {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function makeInstall(
  overrides: Partial<AppInstallationRow> = {}
): AppInstallationRow {
  return {
    id: 1,
    organizationId: "org-1",
    provider: "github",
    providerInstance: "cloud",
    providerAppId: "app-123",
    externalTenantId: "98765",
    authProfileId: null,
    status: "active",
    metadata: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** A `fetch` stub returning GitHub's success body, counting invocations. */
function mockExchange(body: { token: string; expires_at: string }) {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    impl,
    get calls() {
      return calls;
    },
  };
}

describe("buildGitHubAppJwt", () => {
  test("RS256 header, iss/iat/exp claims, <=600s window, valid signature", () => {
    const nowMs = 1_700_000_000_000;
    const jwt = buildGitHubAppJwt({
      appId: "424242",
      privateKeyPem: privateKey,
      nowMs,
    });

    const [headerSeg, claimsSeg, sigSeg] = jwt.split(".");
    expect(headerSeg && claimsSeg && sigSeg).toBeTruthy();

    const header = base64urlToJson(headerSeg!);
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");

    const claims = base64urlToJson(claimsSeg!);
    expect(claims.iss).toBe("424242");
    const iat = claims.iat as number;
    const exp = claims.exp as number;
    const nowSec = Math.floor(nowMs / 1000);
    // iat is backdated (<= now) to tolerate clock skew.
    expect(iat).toBeLessThanOrEqual(nowSec);
    // GitHub hard-caps the App JWT lifetime at 600s.
    expect(exp - iat).toBeLessThanOrEqual(600);
    expect(exp).toBeGreaterThan(nowSec);

    // Signature verifies against the public key over `header.claims`.
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerSeg}.${claimsSeg}`);
    verifier.end();
    const sig = Buffer.from(
      sigSeg!.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    );
    expect(verifier.verify(publicKey, sig)).toBe(true);
  });

  test("accepts a PEM with literal \\n escapes (env-var form)", () => {
    const escaped = privateKey.replace(/\n/g, "\\n");
    const jwt = buildGitHubAppJwt({
      appId: "1",
      privateKeyPem: escaped,
      nowMs: 1_700_000_000_000,
    });
    const [headerSeg, claimsSeg, sigSeg] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerSeg}.${claimsSeg}`);
    verifier.end();
    const sig = Buffer.from(
      sigSeg!.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    );
    expect(verifier.verify(publicKey, sig)).toBe(true);
  });
});

describe("GitHubInstallationTokenProvider.mintToken", () => {
  const env = {
    GITHUB_APP_ID: "424242",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };

  test("exchanges the App JWT for an installation token", async () => {
    const exchange = mockExchange({
      token: "ghs_minted_abc",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const provider = new GitHubInstallationTokenProvider({
      env,
      fetchImpl: exchange.impl,
      cache: new InMemoryInstallationTokenCache(),
    });

    const minted = await provider.mintToken(makeInstall());
    expect(minted.token).toBe("ghs_minted_abc");
    expect(Date.parse(minted.expiresAt)).toBeGreaterThan(Date.now());
    expect(exchange.calls).toBe(1);
  });

  test("serves a cached token within its lifetime (no second exchange)", async () => {
    const exchange = mockExchange({
      token: "ghs_cached",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const provider = new GitHubInstallationTokenProvider({
      env,
      fetchImpl: exchange.impl,
      cache: new InMemoryInstallationTokenCache(),
    });

    const first = await provider.mintToken(makeInstall());
    const second = await provider.mintToken(makeInstall());
    expect(second.token).toBe(first.token);
    expect(exchange.calls).toBe(1);
  });

  test("re-mints when the cached token is inside the refresh window", async () => {
    let nextExpiry = new Date(Date.now() + 30_000).toISOString(); // < 60s skew
    const calls: number[] = [];
    const impl = (async () => {
      calls.push(1);
      return new Response(
        JSON.stringify({ token: `ghs_${calls.length}`, expires_at: nextExpiry }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    const provider = new GitHubInstallationTokenProvider({
      env,
      fetchImpl: impl,
      cache: new InMemoryInstallationTokenCache({ refreshSkewMs: 60_000 }),
    });

    const first = await provider.mintToken(makeInstall());
    // First token expires within the 60s refresh skew → not cacheable.
    nextExpiry = new Date(Date.now() + 3_600_000).toISOString();
    const second = await provider.mintToken(makeInstall());
    expect(first.token).toBe("ghs_1");
    expect(second.token).toBe("ghs_2");
    expect(calls.length).toBe(2);
  });

  test("missing App env config → missing_app_config", async () => {
    const provider = new GitHubInstallationTokenProvider({
      env: {},
      fetchImpl: mockExchange({ token: "x", expires_at: "y" }).impl,
    });
    await expect(provider.mintToken(makeInstall())).rejects.toMatchObject({
      reason: "missing_app_config",
    });
  });

  test("non-OK exchange (revoked/suspended install) → exchange_failed with status", async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
      })) as unknown as typeof fetch;
    const provider = new GitHubInstallationTokenProvider({ env, fetchImpl: impl });

    try {
      await provider.mintToken(makeInstall());
      throw new Error("expected mintToken to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InstallationTokenError);
      expect((err as InstallationTokenError).reason).toBe("exchange_failed");
      expect((err as InstallationTokenError).status).toBe(404);
    }
  });

  test("network error → exchange_failed", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const provider = new GitHubInstallationTokenProvider({ env, fetchImpl: impl });
    await expect(provider.mintToken(makeInstall())).rejects.toMatchObject({
      reason: "exchange_failed",
    });
  });

  test("honors per-method appIdKey/privateKeyKey from install metadata", async () => {
    const exchange = mockExchange({
      token: "ghs_custom_keys",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const provider = new GitHubInstallationTokenProvider({
      env: { GHE_APP_ID: "9", GHE_APP_KEY: privateKey },
      fetchImpl: exchange.impl,
    });
    const minted = await provider.mintToken(
      makeInstall({
        metadata: { appIdKey: "GHE_APP_ID", privateKeyKey: "GHE_APP_KEY" },
      })
    );
    expect(minted.token).toBe("ghs_custom_keys");
  });
});

describe("InstallationTokenRegistry", () => {
  let registry: InstallationTokenRegistry;
  const stub: InstallationTokenProvider = {
    provider: "github",
    mintToken: async () => ({ token: "stub", expiresAt: "2999-01-01T00:00:00Z" }),
  };

  beforeEach(() => {
    registry = new InstallationTokenRegistry();
    registry.register(stub);
  });

  test("delegates to the registered provider for an active install", async () => {
    const minted = await registry.mintFor(makeInstall());
    expect(minted.token).toBe("stub");
  });

  test("refuses to mint for a non-active install → install_inactive", async () => {
    await expect(
      registry.mintFor(makeInstall({ status: "suspended" }))
    ).rejects.toMatchObject({ reason: "install_inactive" });
    await expect(
      registry.mintFor(makeInstall({ status: "revoked" }))
    ).rejects.toMatchObject({ reason: "install_inactive" });
  });

  test("unsupported provider → provider_unsupported", async () => {
    await expect(
      registry.mintFor(makeInstall({ provider: "jira" }))
    ).rejects.toMatchObject({ reason: "provider_unsupported" });
  });
});

describe("InMemoryInstallationTokenCache", () => {
  test("returns null for an entry inside the refresh window", () => {
    const cache = new InMemoryInstallationTokenCache({ refreshSkewMs: 60_000 });
    cache.set("k", {
      token: "t",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    expect(cache.get("k")).toBeNull();
  });

  test("returns a live entry beyond the refresh window", () => {
    const cache = new InMemoryInstallationTokenCache({ refreshSkewMs: 60_000 });
    cache.set("k", {
      token: "t",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(cache.get("k")?.token).toBe("t");
  });

  test("treats an unparseable expiry as stale", () => {
    const cache = new InMemoryInstallationTokenCache();
    cache.set("k", { token: "t", expiresAt: "not-a-date" });
    expect(cache.get("k")).toBeNull();
  });
});
