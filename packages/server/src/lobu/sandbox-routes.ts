/**
 * Sandboxes CRUD for the embedded Lobu gateway.
 *
 * A sandbox binds a runtime provider to an org's vault credential. The `builtin`
 * runtime is synthetic and devices are virtual (`/api/me/devices`), so neither
 * is a row here — this surface manages provider-backed sandboxes only. All
 * routes are org-scoped via mcpAuth + orgContext. Reads need only that; every
 * MUTATION additionally requires org owner/admin (`requireManageAgentAccess`),
 * because a sandbox is an org-level credential shared by every agent — the
 * same tier as the inference providers next to it. Deleting one silently
 * drops dependent agents back to the built-in runtime, so it is not a
 * per-member action.
 */

import { Hono } from "hono";
import { mcpAuth } from "../auth/middleware";
import {
	getGatewayRuntimeProvider,
	listGatewayRuntimeProviderIds,
} from "../gateway/runtime/index";
import type { Env } from "../index";
import { isCloudMode } from "../utils/cloud-mode";
import { requireManageAgentAccess } from "./agent-routes";
import { orgContext } from "./stores/org-context";
import {
	readSandboxSecret,
	writeSandboxSecret,
} from "./stores/provider-secrets";
import {
	createSandbox,
	deleteSandbox,
	listSandboxes,
	type SandboxRow,
	setSandboxCredentialName,
} from "./stores/sandbox-store";

const routes = new Hono<{ Bindings: Env }>();

routes.use("*", mcpAuth);
routes.use("*", async (c, next) => {
	const orgId = c.get("organizationId");
	if (!orgId) return c.json({ error: "Organization required" }, 401);
	return orgContext.run({ organizationId: orgId }, next);
});

/**
 * Validate a credential payload against the provider's declared fields WITHOUT
 * writing anything — so create-with-credential can validate before inserting the
 * sandbox row (no orphaned row on a bad credential).
 */
function validateCredential(
	providerKind: string,
	credential: Record<string, unknown>,
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

/**
 * Write a provider's credential fields to the vault and mark the sandbox
 * credentialed. Validates every supplied field against the provider's declared
 * credentialFields, and requires all `required` fields be present.
 */
async function applyCredential(
	sandboxId: string,
	providerKind: string,
	organizationId: string,
	credential: Record<string, unknown>,
): Promise<{ error: string } | null> {
	const invalid = validateCredential(providerKind, credential);
	if (invalid) return invalid;
	const provider = getGatewayRuntimeProvider(providerKind);
	if (!provider) return { error: `Unknown runtime provider: ${providerKind}` };

	for (const field of provider.credentialFields) {
		const value = credential[field.key];
		if (typeof value === "string" && value.trim()) {
			await writeSandboxSecret(sandboxId, field.key, organizationId, value);
		}
	}
	await setSandboxCredentialName(sandboxId, organizationId);
	return null;
}

// List sandboxes (read): builtin (synthetic) + provider rows + the set of
// connectable provider kinds. Devices are merged client-side from /api/me/devices.
routes.get("/", async (c) => {
	const orgId = c.get("organizationId") as string;
	const rows = await listSandboxes(orgId);
	const availableProviders = listGatewayRuntimeProviderIds();
	// `connected` reflects the ACTUAL vault contents (the provider's required
	// credential fields), not the stale `credential_name` column — so a credential
	// written by any path shows correctly. `details` carries only the non-secret
	// identifier fields (e.g. teamId/projectId) for display; secrets never leave.
	const sandboxes = await Promise.all(
		rows.map((row) => decorateSandbox(row, orgId)),
	);
	return c.json({
		builtin: {
			id: "builtin",
			kind: "builtin",
			// Display-only: enforcement (forbid builtin in cloud) is a follow-up.
			availableInCloud: !isCloudMode(),
		},
		sandboxes,
		availableProviders,
		providerCatalog: availableProviders.flatMap((id) => {
			const provider = getGatewayRuntimeProvider(id);
			if (!provider) return [];
			return [
				{
					id,
					credentialFields: provider.credentialFields.map(
						({ key, label, required, secret }) => ({
							key,
							label,
							required,
							secret,
						})
					),
				},
			];
		}),
	});
});

async function decorateSandbox(
	sandbox: SandboxRow,
	organizationId: string,
): Promise<SandboxRow & { details: Record<string, string> }> {
	const provider = getGatewayRuntimeProvider(sandbox.providerKind);
	if (!provider) return { ...sandbox, connected: false, details: {} };
	const details: Record<string, string> = {};
	let connected = true;
	for (const field of provider.credentialFields) {
		const value = await readSandboxSecret(
			sandbox.id,
			field.key,
			organizationId,
		);
		if (value) {
			if (field.secret === false) details[field.key] = value;
		} else if (field.required) {
			connected = false;
		}
	}
	return { ...sandbox, connected, details };
}

// Create a sandbox, optionally writing its credential in the same call.
routes.post("/", async (c) => {
	const rejection = requireManageAgentAccess(c);
	if (rejection) return rejection;

	const orgId = c.get("organizationId") as string;
	let body: {
		name?: unknown;
		provider_kind?: unknown;
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

	// Validate the credential BEFORE inserting the row, so a bad credential can't
	// leave an orphaned sandbox behind.
	const hasCredential =
		!!body.credential && typeof body.credential === "object";
	if (hasCredential) {
		const invalid = validateCredential(
			providerKind,
			body.credential as Record<string, unknown>,
		);
		if (invalid) return c.json({ error: invalid.error }, 400);
	}

	const sandbox = await createSandbox(orgId, { name, providerKind });

	if (hasCredential) {
		const result = await applyCredential(
			sandbox.id,
			providerKind,
			orgId,
			body.credential as Record<string, unknown>,
		);
		if (result) {
			// Vault write failed after the row was created — roll back the row.
			await deleteSandbox(sandbox.id, orgId).catch(() => {});
			return c.json({ error: result.error }, 400);
		}
		sandbox.connected = true;
	}

	return c.json({ sandbox }, 201);
});

// Rotate/set a sandbox's credential.
routes.put("/:id/credential", async (c) => {
	const rejection = requireManageAgentAccess(c);
	if (rejection) return rejection;

	const orgId = c.get("organizationId") as string;
	const id = c.req.param("id");
	const sandboxes = await listSandboxes(orgId);
	const sandbox = sandboxes.find((s) => s.id === id);
	if (!sandbox) return c.json({ error: "Sandbox not found" }, 404);

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
		sandbox.providerKind,
		orgId,
		body.credential as Record<string, unknown>,
	);
	if (result) return c.json({ error: result.error }, 400);
	return c.json({ success: true });
});

// Delete a sandbox; dependent agents fall back to the default runtime.
routes.delete("/:id", async (c) => {
	const rejection = requireManageAgentAccess(c);
	if (rejection) return rejection;

	const orgId = c.get("organizationId") as string;
	const id = c.req.param("id");
	if (id === "builtin") {
		return c.json({ error: "The built-in sandbox cannot be deleted" }, 400);
	}
	const deleted = await deleteSandbox(id, orgId);
	if (!deleted) return c.json({ error: "Sandbox not found" }, 404);
	return c.json({ success: true });
});

export { routes as sandboxRoutes };
