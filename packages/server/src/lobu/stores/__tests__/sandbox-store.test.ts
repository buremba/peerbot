/**
 * deleteSandbox credential sweep — runs against whichever backend globalSetup
 * selected (ephemeral embedded Postgres with `bun run test`, real Postgres with
 * DATABASE_URL set). Verifies that deleting a sandbox also purges its
 * runtime-connection credentials from the vault, and that a sibling sandbox's
 * credentials survive.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../../__tests__/setup/test-db";
import { readSandboxSecret, writeSandboxSecret } from "../provider-secrets";
import { createSandbox, deleteSandbox } from "../sandbox-store";

const ORG = "org-sandbox-cred-sweep";

/** Count live vault rows for one sandbox's credential fields. */
async function countSandboxSecrets(
  organizationId: string,
  sandboxId: string
): Promise<number> {
  const db = getTestDb();
  const rows = await db<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM agent_secrets
    WHERE organization_id = ${organizationId}
      AND name LIKE ${`sandbox:${sandboxId}:%`}
      AND (expires_at IS NULL OR expires_at > now())
  `;
  return rows[0]?.count ?? 0;
}

describe("deleteSandbox credential sweep", () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  afterEach(async () => {
    const db = getTestDb();
    await db`TRUNCATE sandboxes, agent_secrets`;
  });

  it("deletes the sandbox's vault credentials with the row", async () => {
    const sandbox = await createSandbox(ORG, {
      name: "vercel-prod",
      providerKind: "vercel",
    });
    await writeSandboxSecret(sandbox.id, "token", ORG, "vercel-token-xxxx");

    expect(await countSandboxSecrets(ORG, sandbox.id)).toBe(1);
    expect(await readSandboxSecret(sandbox.id, "token", ORG)).toBe(
      "vercel-token-xxxx"
    );

    const deleted = await deleteSandbox(sandbox.id, ORG);
    expect(deleted).toBe(true);

    // No decryptable provider token survives the deleted row.
    expect(await countSandboxSecrets(ORG, sandbox.id)).toBe(0);
    expect(await readSandboxSecret(sandbox.id, "token", ORG)).toBeNull();
  });

  it("leaves a sibling sandbox's credentials untouched", async () => {
    const a = await createSandbox(ORG, {
      name: "vercel-a",
      providerKind: "vercel",
    });
    const b = await createSandbox(ORG, {
      name: "vercel-b",
      providerKind: "vercel",
    });
    await writeSandboxSecret(a.id, "token", ORG, "vercel-token-aaaa");
    await writeSandboxSecret(b.id, "token", ORG, "vercel-token-bbbb");

    expect(await deleteSandbox(a.id, ORG)).toBe(true);

    // A's secret was swept with its row; B's survives.
    expect(await countSandboxSecrets(ORG, a.id)).toBe(0);
    expect(await countSandboxSecrets(ORG, b.id)).toBe(1);
    expect(await readSandboxSecret(b.id, "token", ORG)).toBe(
      "vercel-token-bbbb"
    );
  });

  it("succeeds for a sandbox that was never credentialed", async () => {
    const sandbox = await createSandbox(ORG, {
      name: "vercel-empty",
      providerKind: "vercel",
    });

    expect(await deleteSandbox(sandbox.id, ORG)).toBe(true);
    expect(await countSandboxSecrets(ORG, sandbox.id)).toBe(0);
  });
});
