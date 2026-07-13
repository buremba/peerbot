/**
 * deleteEnvironment credential sweep — runs against whichever backend
 * globalSetup selected (ephemeral embedded Postgres with `bun run test`, real
 * Postgres with DATABASE_URL set). Verifies that deleting an environment also
 * purges its runtime-connection credentials from the vault, and that a sibling
 * environment's credentials survive.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../../__tests__/setup/test-db";
import { createEnvironment, deleteEnvironment } from "../environment-store";
import { readEnvironmentSecret, writeEnvironmentSecret } from "../provider-secrets";

const ORG = "org-env-cred-sweep";

/** Count live vault rows for one environment's credential fields. */
async function countEnvironmentSecrets(
  organizationId: string,
  environmentId: string
): Promise<number> {
  const db = getTestDb();
  const rows = await db<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM agent_secrets
    WHERE organization_id = ${organizationId}
      AND name LIKE ${`environment:${environmentId}:%`}
      AND (expires_at IS NULL OR expires_at > now())
  `;
  return rows[0]?.count ?? 0;
}

describe("deleteEnvironment credential sweep", () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  afterEach(async () => {
    const db = getTestDb();
    await db`TRUNCATE environments, agent_secrets`;
  });

  it("deletes the environment's vault credentials with the row", async () => {
    const env = await createEnvironment(ORG, {
      name: "vercel-prod",
      providerKind: "vercel",
    });
    await writeEnvironmentSecret(env.id, "token", ORG, "vercel-token-xxxx");

    expect(await countEnvironmentSecrets(ORG, env.id)).toBe(1);
    expect(await readEnvironmentSecret(env.id, "token", ORG)).toBe(
      "vercel-token-xxxx"
    );

    const deleted = await deleteEnvironment(env.id, ORG);
    expect(deleted).toBe(true);

    // No decryptable provider token survives the deleted row.
    expect(await countEnvironmentSecrets(ORG, env.id)).toBe(0);
    expect(await readEnvironmentSecret(env.id, "token", ORG)).toBeNull();
  });

  it("leaves a sibling environment's credentials untouched", async () => {
    const a = await createEnvironment(ORG, {
      name: "vercel-a",
      providerKind: "vercel",
    });
    const b = await createEnvironment(ORG, {
      name: "vercel-b",
      providerKind: "vercel",
    });
    await writeEnvironmentSecret(a.id, "token", ORG, "vercel-token-aaaa");
    await writeEnvironmentSecret(b.id, "token", ORG, "vercel-token-bbbb");

    expect(await deleteEnvironment(a.id, ORG)).toBe(true);

    // A's secret was swept with its row; B's survives.
    expect(await countEnvironmentSecrets(ORG, a.id)).toBe(0);
    expect(await countEnvironmentSecrets(ORG, b.id)).toBe(1);
    expect(await readEnvironmentSecret(b.id, "token", ORG)).toBe(
      "vercel-token-bbbb"
    );
  });

  it("succeeds for an environment that was never credentialed", async () => {
    const env = await createEnvironment(ORG, {
      name: "vercel-empty",
      providerKind: "vercel",
    });

    expect(await deleteEnvironment(env.id, ORG)).toBe(true);
    expect(await countEnvironmentSecrets(ORG, env.id)).toBe(0);
  });
});
