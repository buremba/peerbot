/**
 * Tests for the shared credential-store primitives (credentials.ts). These back
 * BOTH the CLI's `lobu login` store and the embedded server's managed-connector
 * resolver, so the v2 file format + refresh semantics must stay exact.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BaseCredential,
  credentialCanRefresh,
  credentialNeedsRefresh,
  deleteContextCredential,
  readContextCredential,
  readCredentialStore,
  refreshOAuthToken,
  writeContextCredential,
} from "../credentials";

const DEFAULT = "lobu";
let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lobu-cred-"));
  file = join(dir, "credentials.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("credential store I/O", () => {
  test("write → read round-trips and preserves extra (non-base) fields", async () => {
    interface Rich extends BaseCredential {
      email?: string;
      localWorkerToken?: string;
    }
    await writeContextCredential<Rich>(file, "lobu", DEFAULT, {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 123,
      email: "a@b.com",
      localWorkerToken: "wt",
    });
    const read = await readContextCredential<Rich>(file, "lobu", DEFAULT);
    expect(read).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 123,
      email: "a@b.com",
      localWorkerToken: "wt",
    });
  });

  test("writes are 0600 and a second context does not clobber the first", async () => {
    await writeContextCredential(file, "lobu", DEFAULT, { accessToken: "a" });
    await writeContextCredential(file, "work", DEFAULT, { accessToken: "b" });
    const store = await readCredentialStore(file, DEFAULT);
    expect(store.contexts.lobu?.accessToken).toBe("a");
    expect(store.contexts.work?.accessToken).toBe("b");

    const { stat } = await import("node:fs/promises");
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("a legacy single-context file migrates under the default context", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      file,
      JSON.stringify({ accessToken: "legacy", refreshToken: "r" })
    );
    const read = await readContextCredential(file, DEFAULT, DEFAULT);
    expect(read?.accessToken).toBe("legacy");
    // A non-default context is absent in a legacy file.
    expect(await readContextCredential(file, "work", DEFAULT)).toBeNull();
  });

  test("a missing or corrupt file reads as an empty store", async () => {
    expect((await readCredentialStore(file, DEFAULT)).contexts).toEqual({});
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{not json");
    expect((await readCredentialStore(file, DEFAULT)).contexts).toEqual({});
  });

  test("entries without an accessToken (or an EMPTY-string one) are dropped on read", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        contexts: {
          lobu: { accessToken: "ok" },
          bad: { refreshToken: "x" },
          // An empty-string accessToken is invalid — `lobu login` is the
          // load-bearing primitive and must treat "" as no credential.
          empty: { accessToken: "" },
        },
      })
    );
    const store = await readCredentialStore(file, DEFAULT);
    expect(store.contexts.lobu?.accessToken).toBe("ok");
    expect(store.contexts.bad).toBeUndefined();
    expect(store.contexts.empty).toBeUndefined();
  });

  test("concurrent writes never corrupt the store and leave no temp files", async () => {
    // The server's refresh write-back and the CLI can write the store at the
    // same time. The atomic temp-file + rename write guarantees a reader always
    // sees ONE writer's COMPLETE file (never a half-written/interleaved one) and
    // no `.tmp-*` turds are left behind. (It is last-writer-wins on the rename —
    // we don't merge concurrent read-modify-writes — so not every context is
    // guaranteed to survive; the invariant being proven here is no CORRUPTION,
    // not no-lost-update.)
    const { readdir } = await import("node:fs/promises");
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        writeContextCredential(file, `ctx-${i % 5}`, DEFAULT, {
          accessToken: `token-${i}`,
        })
      )
    );

    // The file parses cleanly (no interleaved/truncated JSON) — every surviving
    // entry is a valid credential.
    const store = await readCredentialStore(file, DEFAULT);
    expect(Object.keys(store.contexts).length).toBeGreaterThan(0);
    for (const cred of Object.values(store.contexts)) {
      expect(typeof cred.accessToken).toBe("string");
      expect(cred.accessToken.length).toBeGreaterThan(0);
    }

    // Perms survive concurrent overwrites.
    const { stat } = await import("node:fs/promises");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    // No leftover temp files in the dir.
    const entries = await readdir(dir);
    expect(entries.filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect(entries).toContain("credentials.json");
  });

  test("delete removes one context; deletes the file when none remain", async () => {
    await writeContextCredential(file, "lobu", DEFAULT, { accessToken: "a" });
    await writeContextCredential(file, "work", DEFAULT, { accessToken: "b" });
    await deleteContextCredential(file, "lobu", DEFAULT);
    expect(await readContextCredential(file, "lobu", DEFAULT)).toBeNull();
    expect(
      (await readContextCredential(file, "work", DEFAULT))?.accessToken
    ).toBe("b");

    await deleteContextCredential(file, "work", DEFAULT);
    await expect(readFile(file, "utf-8")).rejects.toThrow();
  });
});

describe("refresh predicates", () => {
  test("credentialNeedsRefresh respects the expiry buffer", () => {
    expect(credentialNeedsRefresh({ accessToken: "a" })).toBe(false); // no expiry
    expect(
      credentialNeedsRefresh({
        accessToken: "a",
        expiresAt: Date.now() + 600_000,
      })
    ).toBe(false);
    expect(
      credentialNeedsRefresh({
        accessToken: "a",
        expiresAt: Date.now() + 1_000,
      })
    ).toBe(true);
    expect(
      credentialNeedsRefresh({ accessToken: "a", expiresAt: Date.now() - 1 })
    ).toBe(true);
  });

  test("credentialCanRefresh requires a refresh token, client id, and token endpoint", () => {
    expect(credentialCanRefresh({ accessToken: "a" })).toBe(false);
    expect(credentialCanRefresh({ accessToken: "a", refreshToken: "r" })).toBe(
      false
    );
    expect(
      credentialCanRefresh({
        accessToken: "a",
        refreshToken: "r",
        oauth: { clientId: "c", tokenEndpoint: "https://x/token" },
      })
    ).toBe(true);
  });
});

describe("refreshOAuthToken", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns rotated tokens on success", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "new-at",
            refresh_token: "new-rt",
            expires_in: 3600,
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;
    const result = await refreshOAuthToken(
      "https://x/token",
      { clientId: "c" },
      "old-rt"
    );
    expect(result).toEqual({
      accessToken: "new-at",
      refreshToken: "new-rt",
      expiresIn: 3600,
    });
  });

  test("omits refreshToken/expiresIn when the issuer does not return them", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ access_token: "only-at" }), {
          status: 200,
        })
    ) as unknown as typeof fetch;
    const result = await refreshOAuthToken(
      "https://x/token",
      { clientId: "c" },
      "rt"
    );
    expect(result).toEqual({
      accessToken: "only-at",
      refreshToken: undefined,
      expiresIn: undefined,
    });
  });

  test("returns null on non-2xx, a missing access_token, or a network error", async () => {
    globalThis.fetch = mock(
      async () => new Response("nope", { status: 401 })
    ) as unknown as typeof fetch;
    expect(
      await refreshOAuthToken("https://x/token", { clientId: "c" }, "rt")
    ).toBeNull();

    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ token_type: "bearer" }), { status: 200 })
    ) as unknown as typeof fetch;
    expect(
      await refreshOAuthToken("https://x/token", { clientId: "c" }, "rt")
    ).toBeNull();

    globalThis.fetch = mock(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(
      await refreshOAuthToken("https://x/token", { clientId: "c" }, "rt")
    ).toBeNull();
  });
});
