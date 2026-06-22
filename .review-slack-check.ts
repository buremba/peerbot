import { getDb } from "./packages/server/src/db/client.js";
import {
  ensureDbForGatewayTests,
  ensureEncryptionKey,
  resetTestDatabase,
  seedAgentRow,
} from "./packages/server/src/gateway/__tests__/helpers/db-setup.js";
import { PostgresSecretStore } from "./packages/server/src/lobu/stores/postgres-secret-store.js";
import { SecretStoreRegistry } from "./packages/server/src/gateway/secrets/index.js";
import { createSlackAppInstallationStore } from "./packages/server/src/lobu/stores/slack-app-installation-store.js";
await ensureDbForGatewayTests();
ensureEncryptionKey();
await resetTestDatabase();
await seedAgentRow("ta", { organizationId: "org-a" });
await seedAgentRow("tb", { organizationId: "org-b" });
const ps = new PostgresSecretStore();
const ss = new SecretStoreRegistry(ps, { secret: ps });
const store = createSlackAppInstallationStore(ss);
const a1 = await store.upsertByTeam("org-a", "TBUG", { botToken: "a1" });
const b = await store.upsertByTeam("org-b", "TBUG", { botToken: "b" });
const a2 = await store.upsertByTeam("org-a", "TBUG", { botToken: "a2" });
const sql = getDb();
const rows =
  await sql`select id,status,organization_id,metadata->>'external_id' as ext from app_installations where provider='slack' and external_tenant_id='TBUG' order by id`;
console.log(
  JSON.stringify({
    a1: a1.id,
    b: b.id,
    a2: a2.id,
    rows,
    listA: (await store.list("org-a")).map((r) => r.id),
  })
);
