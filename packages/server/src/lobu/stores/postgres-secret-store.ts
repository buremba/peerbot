/**
 * PostgresSecretStore — WritableSecretStore backed by the `agent_secrets`
 * table. Stores AES-256-GCM ciphertext produced by @lobu/core's encrypt(),
 * keyed by logical name, and returns `secret://<encoded-name>` refs.
 *
 * Paired with SecretStoreRegistry and passed as the `secretStore` option to
 * Gateway from `src/lobu/gateway.ts` so lobu's ChatInstanceManager can
 * persist connection secrets durably.
 */

import {
  createBuiltinSecretRef,
  decrypt,
  encrypt,
  parseSecretRef,
  type SecretRef,
} from '@lobu/core';
import { getDb } from '../../db/client';
import type { WritableSecretStore } from '../../gateway/secrets/index';
import logger from '../../utils/logger';

// SecretListEntry and SecretPutOptions are defined inside the gateway's
// secrets module but not re-exported from its public barrel. Derive them
// from WritableSecretStore's method signatures so we stay aligned with
// upstream without reaching into internal paths.
type SecretPutOptions = NonNullable<Parameters<WritableSecretStore['put']>[2]>;
type SecretListEntry = Awaited<ReturnType<WritableSecretStore['list']>>[number];

const BACKEND_NAME = 'postgres';
const DEFAULT_SCHEME = 'secret';

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Escape LIKE special chars so a caller-supplied prefix can't smuggle
 * wildcards into our prefix scan. Paired with `ESCAPE '\'` in the query.
 */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Resolve a name-or-ref input to a plain logical name. Throws on refs that
 * target a non-default scheme, matching RedisSecretStore's behavior.
 */
function resolveName(nameOrRef: string): string {
  const parsed = parseSecretRef(nameOrRef);
  if (!parsed) return nameOrRef;
  if (parsed.scheme !== DEFAULT_SCHEME) {
    throw new Error(`Unsupported writable secret backend: ${parsed.scheme}`);
  }
  const decoded = safeDecodeURIComponent(parsed.path);
  if (decoded === null) {
    throw new Error(`Invalid secret ref path encoding: ${parsed.path}`);
  }
  return decoded;
}

export class PostgresSecretStore implements WritableSecretStore {
  async get(ref: SecretRef): Promise<string | null> {
    const parsed = parseSecretRef(ref);
    if (!parsed || parsed.scheme !== DEFAULT_SCHEME) return null;

    const name = safeDecodeURIComponent(parsed.path);
    if (name === null) {
      logger.warn({ ref }, '[secret-store] Invalid secret ref path encoding');
      return null;
    }

    const sql = getDb();
    const rows = await sql<{ ciphertext: string }>`
      SELECT ciphertext
      FROM agent_secrets
      WHERE name = ${name}
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `;
    const ciphertext = rows[0]?.ciphertext;
    if (!ciphertext) return null;

    try {
      return decrypt(ciphertext);
    } catch (error) {
      logger.warn(
        { ref, error: error instanceof Error ? error.message : String(error) },
        '[secret-store] Failed to decrypt stored secret'
      );
      return null;
    }
  }

  async put(name: string, value: string, options?: SecretPutOptions): Promise<SecretRef> {
    const ciphertext = encrypt(value);
    const expiresAt = options?.ttlSeconds ? new Date(Date.now() + options.ttlSeconds * 1000) : null;

    const sql = getDb();
    await sql`
      INSERT INTO agent_secrets (name, ciphertext, expires_at, created_at, updated_at)
      VALUES (${name}, ${ciphertext}, ${expiresAt}, now(), now())
      ON CONFLICT (name) DO UPDATE SET
        ciphertext = EXCLUDED.ciphertext,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    `;

    return createBuiltinSecretRef(encodeURIComponent(name));
  }

  async delete(nameOrRef: string): Promise<void> {
    const name = resolveName(nameOrRef);
    const sql = getDb();
    await sql`DELETE FROM agent_secrets WHERE name = ${name}`;
  }

  async list(prefix?: string): Promise<SecretListEntry[]> {
    const sql = getDb();
    const rows = prefix
      ? await sql<{ name: string; updated_at: Date }>`
          SELECT name, updated_at
          FROM agent_secrets
          WHERE name LIKE ${escapeLikePrefix(prefix) + '%'} ESCAPE '\'
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY name ASC
        `
      : await sql<{ name: string; updated_at: Date }>`
          SELECT name, updated_at
          FROM agent_secrets
          WHERE expires_at IS NULL OR expires_at > now()
          ORDER BY name ASC
        `;

    return rows.map((row) => ({
      ref: createBuiltinSecretRef(encodeURIComponent(row.name)),
      backend: BACKEND_NAME,
      name: row.name,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.getTime() : Date.now(),
    }));
  }
}
