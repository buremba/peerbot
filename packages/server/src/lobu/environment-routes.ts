/**
 * Environments CRUD for the embedded Lobu gateway.
 *
 * An environment binds a runtime provider to an org's vault credential. The
 * `builtin` runtime is synthetic and devices are virtual (`/api/me/devices`),
 * so neither is a row here — this surface manages provider-backed sandbox
 * environments only. All routes are org-scoped via mcpAuth + orgContext;
 * mutations require a session or an mcp:admin PAT.
 */

import { Hono } from "hono";
import { mcpAuth } from "../auth/middleware";
import { isCloudMode } from "../utils/cloud-mode";
import {
  getGatewayRuntimeProvider,
  listGatewayRuntimeProviderIds,
} from "../gateway/runtime/index";
import type { Env } from "../index";
import {
  createEnvironment,
  deleteEnvironment,
  type EnvironmentRow,
  listEnvironments,
  setEnvironmentCredentialName,
} from "./stores/environment-store";
import {
  readEnvironmentSecret,
  writeEnvironmentSecret,
} from "./stores/provider-secrets";
import { orgContext } from "./stores/org-context";
import { requireSessionOrAdminPat } from "./agent-routes";

const routes = new Hono<{ Bindings: Env }>();

routes.use("*", mcpAuth);
routes.use("*", async (c, next) => {
  const orgId = c.get("organizationId");
  if (!orgId) return c.json({ error: "Organization required" }, 401);
  return orgContext.run({ organizationId: orgId }, next);
});

/**
 * Write a provider's credential fields to the vault and mark the environment
 * credentialed. Validates every supplied field against the provider's declared
 * credentialFields, and requires all `required` fields be present.
 */
/**
 * Validate a credential payload against the provider's declared fields WITHOUT
 * writing anything — so create-with-credential can validate before inserting the
 * environment row (no orphaned row on a bad credential).
 */
function validateCredential(
  providerKind: string,
  credential: Record<string, unknown>
): { error: string } | null {
  const provider = getGatewayRuntimeProvider(providerKind);
  if (!provider) return { error: `Unknown runtime provider: ${providerKind}` };

  const fieldByKey = new Map(provider.credentialFields.map((f) => [f.key, f]));
  for (const key of Object.keys(credential)) {
    if (!fieldByKey.has(key)) {
      return { error: `Unknown credential field for ${providerKind}: ${key}` };
    }
  }
  for (const field of provider.credentialFields) {
    const value = credential[field.key];
    if (typeof value === "string" && value.trim()) continue;
    if (field.required) {
      return { error: `Missing required credential field: ${field.key}` };
    }
  }
  return null;
}

async function applyCredential(
  environmentId: string,
  providerKind: string,
  organizationId: string,
  credential: Record<string, unknown>
): Promise<{ error: string } | null> {
  const invalid = validateCredential(providerKind, credential);
  if (invalid) return invalid;
  const provider = getGatewayRuntimeProvider(providerKind);
  if (!provider) return { error: `Unknown runtime provider: ${providerKind}` };

  for (const field of provider.credentialFields) {
    const value = credential[field.key];
    if (typeof value === "string" && value.trim()) {
      await writeEnvironmentSecret(
        environmentId,
        field.key,
        organizationId,
        value
      );
    }
  }
  await setEnvironmentCredentialName(environmentId, organizationId);
  return null;
}

// List environments (read): builtin (synthetic) + provider rows + the set of
// connectable provider kinds. Devices are merged client-side from /api/me/devices.
routes.get("/", async (c) => {
  const orgId = c.get("organizationId") as string;
  const rows = await listEnvironments(orgId);
  // `connected` reflects the ACTUAL vault contents (the provider's required
  // credential fields), not the stale `credential_name` column — so a credential
  // written by any path shows correctly. `details` carries only the non-secret
  // identifier fields (e.g. teamId/projectId) for display; secrets never leave.
  const environments = await Promise.all(
    rows.map((env) => decorateEnvironment(env, orgId))
  );
  return c.json({
    builtin: {
      id: "builtin",
      kind: "builtin",
      // Display-only: enforcement (forbid builtin in cloud) is a follow-up.
      availableInCloud: !isCloudMode(),
    },
    environments,
    availableProviders: listGatewayRuntimeProviderIds(),
  });
});

async function decorateEnvironment(
  env: EnvironmentRow,
  organizationId: string
): Promise<EnvironmentRow & { details: Record<string, string> }> {
  const provider = getGatewayRuntimeProvider(env.providerKind);
  if (!provider) return { ...env, connected: false, details: {} };
  const details: Record<string, string> = {};
  let connected = true;
  for (const field of provider.credentialFields) {
    const value = await readEnvironmentSecret(env.id, field.key, organizationId);
    if (value) {
      if (field.secret === false) details[field.key] = value;
    } else if (field.required) {
      connected = false;
    }
  }
  return { ...env, connected, details };
}

// Create an environment, optionally writing its credential in the same call.
routes.post("/", async (c) => {
  const rejection = requireSessionOrAdminPat(c);
  if (rejection) return rejection;

  const orgId = c.get("organizationId") as string;
  let body: {
    name?: unknown;
    provider_kind?: unknown;
    scope?: unknown;
    credential?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid or missing JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const providerKind =
    typeof body.provider_kind === "string" ? body.provider_kind.trim() : "";
  if (!name) return c.json({ error: "`name` is required" }, 400);
  if (!getGatewayRuntimeProvider(providerKind)) {
    return c.json({ error: `Unknown runtime provider: ${providerKind}` }, 400);
  }
  const scope = body.scope === "private" ? "private" : "org";

  // Validate the credential BEFORE inserting the row, so a bad credential can't
  // leave an orphaned environment behind.
  const hasCredential =
    !!body.credential && typeof body.credential === "object";
  if (hasCredential) {
    const invalid = validateCredential(
      providerKind,
      body.credential as Record<string, unknown>
    );
    if (invalid) return c.json({ error: invalid.error }, 400);
  }

  const env = await createEnvironment(orgId, { name, providerKind, scope });

  if (hasCredential) {
    const result = await applyCredential(
      env.id,
      providerKind,
      orgId,
      body.credential as Record<string, unknown>
    );
    if (result) {
      // Vault write failed after the row was created — roll back the row.
      await deleteEnvironment(env.id, orgId).catch(() => {});
      return c.json({ error: result.error }, 400);
    }
    env.connected = true;
  }

  return c.json({ environment: env }, 201);
});

// Rotate/set an environment's credential.
routes.put("/:id/credential", async (c) => {
  const rejection = requireSessionOrAdminPat(c);
  if (rejection) return rejection;

  const orgId = c.get("organizationId") as string;
  const id = c.req.param("id");
  const environments = await listEnvironments(orgId);
  const env = environments.find((e) => e.id === id);
  if (!env) return c.json({ error: "Environment not found" }, 404);

  let body: { credential?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid or missing JSON body" }, 400);
  }
  if (!body.credential || typeof body.credential !== "object") {
    return c.json({ error: "Body must include a `credential` object" }, 400);
  }

  const result = await applyCredential(
    id,
    env.providerKind,
    orgId,
    body.credential as Record<string, unknown>
  );
  if (result) return c.json({ error: result.error }, 400);
  return c.json({ success: true });
});

// Delete an environment; dependent agents fall back to the default runtime.
routes.delete("/:id", async (c) => {
  const rejection = requireSessionOrAdminPat(c);
  if (rejection) return rejection;

  const orgId = c.get("organizationId") as string;
  const id = c.req.param("id");
  if (id === "builtin") {
    return c.json({ error: "The built-in environment cannot be deleted" }, 400);
  }
  const deleted = await deleteEnvironment(id, orgId);
  if (!deleted) return c.json({ error: "Environment not found" }, 404);
  return c.json({ success: true });
});

export { routes as environmentRoutes };
