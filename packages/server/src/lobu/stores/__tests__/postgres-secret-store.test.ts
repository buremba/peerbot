/**
 * PostgresSecretStore tests — runs against whichever backend globalSetup
 * selected. With `pnpm test` the backend is ephemeral PGlite; with
 * `pnpm test:pg` (or when DATABASE_URL is set explicitly) it's real
 * Postgres. Tests are written once and verified under both paths.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../../__tests__/setup/test-db';
import { PostgresSecretStore } from '../postgres-secret-store';

describe('PostgresSecretStore', () => {
  let store: PostgresSecretStore;

  beforeEach(async () => {
    await cleanupTestDatabase();
    store = new PostgresSecretStore();
  });

  afterEach(async () => {
    // Leave the table empty for the next test, even if one failed mid-run.
    const db = getTestDb();
    await db`TRUNCATE agent_secrets`;
  });

  describe('put', () => {
    it('returns a secret:// ref with a percent-encoded name', async () => {
      const ref = await store.put('agents/a/openai', 'sk-test-secret');
      expect(ref).toBe('secret://agents%2Fa%2Fopenai');
    });

    it('upserts on repeated put with the same name', async () => {
      await store.put('connections/c1/token', 'first');
      await store.put('connections/c1/token', 'second');

      const ref = 'secret://connections%2Fc1%2Ftoken';
      expect(await store.get(ref)).toBe('second');

      const db = getTestDb();
      const rows = await db<{ count: number }[]>`
        SELECT count(*)::int AS count FROM agent_secrets WHERE name = 'connections/c1/token'
      `;
      expect(rows[0]?.count).toBe(1);
    });

    it('stores ciphertext at rest, never plaintext', async () => {
      const plaintext = 'sk-super-sensitive-value';
      await store.put('connections/c1/token', plaintext);

      const db = getTestDb();
      const rows = await db<{ ciphertext: string }[]>`
        SELECT ciphertext FROM agent_secrets WHERE name = 'connections/c1/token'
      `;
      expect(rows[0]?.ciphertext).toBeTruthy();
      expect(rows[0]?.ciphertext).not.toContain(plaintext);
      // @lobu/core encrypt() format: iv:tag:encrypted, all hex.
      expect(rows[0]?.ciphertext).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    });
  });

  describe('get', () => {
    it('round-trips a stored secret', async () => {
      const ref = await store.put('agents/a/openai', 'sk-round-trip');
      expect(await store.get(ref)).toBe('sk-round-trip');
    });

    it('returns null for an unknown name', async () => {
      expect(await store.get('secret://does-not-exist')).toBeNull();
    });

    it('returns null for a non-default scheme (e.g. aws-sm)', async () => {
      // Still insert one under the same decoded path to be sure the scheme
      // check actually matters, not just the key lookup.
      await store.put('my-secret', 'plaintext-value');
      expect(await store.get('aws-sm://my-secret')).toBeNull();
    });

    it('returns null for a malformed ref', async () => {
      expect(await store.get('not-a-ref')).toBeNull();
      expect(await store.get('secret://')).toBeNull();
    });

    it('returns null once a ttlSeconds value has expired', async () => {
      const ref = await store.put('ephemeral/token', 'short-lived', {
        ttlSeconds: 1,
      });
      expect(await store.get(ref)).toBe('short-lived');

      // Nudge the row's expires_at into the past instead of sleeping — keeps
      // the test deterministic and fast under both backends.
      const db = getTestDb();
      await db`
        UPDATE agent_secrets
        SET expires_at = now() - interval '1 second'
        WHERE name = 'ephemeral/token'
      `;

      expect(await store.get(ref)).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes by bare name', async () => {
      await store.put('foo/bar', 'value');
      await store.delete('foo/bar');
      expect(await store.get('secret://foo%2Fbar')).toBeNull();
    });

    it('deletes by secret:// ref', async () => {
      const ref = await store.put('foo/baz', 'value');
      await store.delete(ref);
      expect(await store.get(ref)).toBeNull();
    });

    it('throws on a ref for an unknown writable backend', async () => {
      await expect(store.delete('aws-sm://some/arn')).rejects.toThrow(
        /Unsupported writable secret backend/
      );
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await store.put('system-env/OPENAI_API_KEY', 'value-1');
      await store.put('agents/a/openai', 'value-2');
      await store.put('agents/b/openai', 'value-3');
    });

    it('lists everything when called without a prefix', async () => {
      const entries = await store.list();
      const names = entries.map((entry) => entry.name).sort();
      expect(names).toEqual(['agents/a/openai', 'agents/b/openai', 'system-env/OPENAI_API_KEY']);
      expect(entries.every((entry) => entry.backend === 'postgres')).toBe(true);
      expect(entries.every((entry) => entry.ref.startsWith('secret://'))).toBe(true);
      expect(entries.every((entry) => typeof entry.updatedAt === 'number')).toBe(true);
    });

    it('filters by logical prefix', async () => {
      const entries = await store.list('agents/');
      const names = entries.map((entry) => entry.name).sort();
      expect(names).toEqual(['agents/a/openai', 'agents/b/openai']);
    });

    it('escapes LIKE wildcards in the caller-supplied prefix', async () => {
      // `_` is a LIKE single-char wildcard. If we didn't escape, it would
      // match any name whose second char is any char — so `system-env/`
      // and `agents/` would both sneak through. With proper escaping,
      // `a_` matches nothing because no stored name starts with `a_`.
      const entries = await store.list('a_');
      expect(entries).toEqual([]);
    });

    it('filters out expired entries', async () => {
      await store.put('ephemeral/secret', 'gone-soon', { ttlSeconds: 60 });
      const db = getTestDb();
      await db`
        UPDATE agent_secrets
        SET expires_at = now() - interval '1 second'
        WHERE name = 'ephemeral/secret'
      `;

      const entries = await store.list('ephemeral/');
      expect(entries).toEqual([]);
    });
  });
});
