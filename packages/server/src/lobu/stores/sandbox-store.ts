import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client.js";
import {
	classifyConversation,
	isAutomationConversationId,
} from "../../gateway/services/conversations-store.js";
import { sandboxSecretName } from "./provider-secrets.js";

/**
 * Persistence for provider-backed sandboxes (the `sandboxes` table). Built-in is
 * synthetic and devices are virtual (`device_workers`), so neither lives here —
 * this store holds only sandbox-provider rows plus the per-agent runtime
 * resolution the token mint reads.
 */

export interface SandboxRow {
	id: string;
	organizationId: string;
	name: string;
	providerKind: string;
	/** True once a credential has been written to the vault for this sandbox. */
	connected: boolean;
	config: Record<string, unknown>;
	createdAt: string | null;
	updatedAt: string | null;
}

function rowToSandbox(row: Record<string, unknown>): SandboxRow {
	return {
		id: String(row.id),
		organizationId: String(row.organization_id),
		name: String(row.name),
		providerKind: String(row.provider_kind),
		connected: row.credential_name != null,
		config: (row.config as Record<string, unknown>) ?? {},
		createdAt: row.created_at ? String(row.created_at) : null,
		updatedAt: row.updated_at ? String(row.updated_at) : null,
	};
}

export async function listSandboxes(
	organizationId: string,
): Promise<SandboxRow[]> {
	const sql = getDb();
	const rows = (await sql`
    SELECT id, organization_id, name, provider_kind,
           credential_name, config, created_at, updated_at
    FROM sandboxes
    WHERE organization_id = ${organizationId}
    ORDER BY created_at ASC
  `) as Array<Record<string, unknown>>;
	return rows.map(rowToSandbox);
}

export async function createSandbox(
	organizationId: string,
	input: {
		name: string;
		providerKind: string;
	},
): Promise<SandboxRow> {
	const sql = getDb();
	const id = `sbx-${randomUUID()}`;
	const rows = (await sql`
    INSERT INTO sandboxes (id, organization_id, name, provider_kind)
    VALUES (${id}, ${organizationId}, ${input.name}, ${input.providerKind})
    RETURNING id, organization_id, name, provider_kind,
              credential_name, config, created_at, updated_at
  `) as Array<Record<string, unknown>>;
	return rowToSandbox(rows[0]);
}

/** Mark a sandbox as credentialed (called after writing its vault keys). */
export async function setSandboxCredentialName(
	id: string,
	organizationId: string,
): Promise<void> {
	const sql = getDb();
	await sql`
    UPDATE sandboxes
    SET credential_name = ${sandboxSecretName(id, "")}, updated_at = now()
    WHERE id = ${id} AND organization_id = ${organizationId}
  `;
}

/**
 * Delete a sandbox, null out any agent pinned to it (so dependent agents fall
 * back to the default runtime), and purge its runtime-connection credentials
 * from the vault — all in ONE transaction. The vault rows (`sandbox:<id>:<field>`)
 * are deleted atomically with the sandbox row, so a transient failure rolls the
 * whole thing back rather than leaving a decryptable provider token behind
 * (which a post-commit purge could do — a retry would see the row already gone
 * and skip the purge). The `:` suffix on the prefix prevents collisions
 * (env-1 vs env-11).
 */
export async function deleteSandbox(
	id: string,
	organizationId: string,
): Promise<boolean> {
	const sql = getDb();
	let deleted = false;
	await sql.begin(async (tx) => {
		const rows = (await tx`
      DELETE FROM sandboxes
      WHERE id = ${id} AND organization_id = ${organizationId}
      RETURNING id
    `) as Array<{ id: string }>;
		deleted = rows.length > 0;
		if (deleted) {
			await tx`
        UPDATE agents
        SET sandbox_id = NULL
        WHERE sandbox_id = ${id} AND organization_id = ${organizationId}
      `;
			await tx`
        DELETE FROM agent_secrets
        WHERE organization_id = ${organizationId}
          AND name LIKE ${`sandbox:${id}:%`}
      `;
		}
	});
	return deleted;
}

/**
 * Resolve an agent's selected sandbox to the runtime claims stamped into its
 * worker token. A provider sandbox → that provider (+ its vault id); no sandbox
 * (or a builtin/deleted one) → `{}` → local just-bash. Provider routing comes
 * SOLELY from the sandbox — there is no deployment-wide env-var fallback. One
 * JOIN query on the dispatch path.
 */
export interface AgentRuntimeSelection {
	runtimeProviderId?: string;
	sandboxId?: string;
}

/**
 * Resolve the agent's sandbox. THROWS on a database error — the pin path must
 * tell "resolved to builtin" apart from "resolution failed" (freezing a
 * transient failure to builtin would poison the pin permanently), and both
 * callers of {@link resolvePinnedSelection} propagate the throw into their
 * retry paths. Callers pre-guard org/agent presence.
 */
async function resolveAgentRuntimeSelection(
	agentId: string,
	organizationId: string,
): Promise<AgentRuntimeSelection> {
	const sql = getDb();
	const rows = (await sql`
    SELECT a.sandbox_id, s.provider_kind
    FROM agents a
    LEFT JOIN sandboxes s
      ON s.id = a.sandbox_id AND s.organization_id = a.organization_id
    WHERE a.id = ${agentId} AND a.organization_id = ${organizationId}
    LIMIT 1
  `) as Array<{ sandbox_id: string | null; provider_kind: string | null }>;
	const row = rows[0];
	// A provider sandbox → run there. Anything else (no sandbox, builtin, or a
	// deleted sandbox row) → local just-bash. Throws on a DB error: the pin path
	// must NOT freeze a failed lookup. Both dispatch callers retry rather than
	// interpreting a failed resolution as a silent {}.
	if (row?.provider_kind && row.sandbox_id != null) {
		return {
			runtimeProviderId: row.provider_kind,
			sandboxId: row.sandbox_id,
		};
	}
	return {};
}

/**
 * Freeze the RESOLVED runtime selection down to the concrete pinned shape stored
 * on the conversations row:
 *  - a provider selection → mode 'provider' + provider id (+ sandbox id);
 *  - no provider          → mode 'builtin' (local just-bash).
 * Frozen so a later agent repoint can't migrate an existing conversation.
 */
function freezeSelection(sel: AgentRuntimeSelection): {
	mode: "builtin" | "provider";
	providerId: string | null;
	sandboxId: string | null;
} {
	if (sel.runtimeProviderId) {
		return {
			mode: "provider",
			providerId: sel.runtimeProviderId,
			sandboxId: sel.sandboxId ?? null,
		};
	}
	return { mode: "builtin", providerId: null, sandboxId: null };
}

/**
 * The conversation-scoped runtime resolver both mint sites call INSTEAD of
 * {@link resolveAgentRuntimeSelection}. Reads the conversation's immutable pin;
 * if unpinned, resolves the agent's CURRENT sandbox selection, then durably pins
 * it via an UPSERT (creating the conversations row if the best-effort dual-write
 * hasn't landed it yet) — first writer wins, and a concurrent first-turn that
 * lost the race re-reads the winner's pin. Reading the pin (not the agent's
 * current sandbox) is what makes an agent repoint never move an existing
 * conversation's sandbox realm. A transient DB failure during resolution skips
 * pinning entirely rather than freezing a wrong (builtin-fallback) realm.
 */
export async function resolvePinnedSelection(args: {
	organizationId: string | undefined;
	agentId: string | undefined;
	platform: string;
	conversationId: string;
}): Promise<AgentRuntimeSelection> {
	const { organizationId, agentId, conversationId } = args;
	if (!organizationId || !agentId) return {};
	// Automation runs are ephemeral and deliberately have NO conversations row (the
	// live dual-write excludes them via isAutomationConversationId). Honor the same
	// exclusion here: never pin and never materialize a listing row for an automation —
	// resolve the agent's current selection live. A repointed automation just picks up
	// the new realm on its next run, which is what we want for automations.
	if (isAutomationConversationId(conversationId)) {
		return resolveAgentRuntimeSelection(agentId, organizationId);
	}
	// The conversations row is keyed on the STORED platform (api→web, lowercased) —
	// classify identically here so the pin SELECT/UPDATE hits the row the live
	// dual-write created. Querying with the raw dispatch platform ("api") would
	// never match the stored "web" row, so web conversations would never pin.
	const { storedPlatform: platform, kind } = classifyConversation(
		args.platform,
	);
	const sql = getDb();

	// 1. Fast-path read of an existing pin. On a read ERROR we deliberately do NOT
	//    fall back to the agent's current (mutable) sandbox — that would run a
	//    repointed conversation in a different realm than its pin, breaking
	//    immutability. Instead we fall through to the upsert path below, whose
	//    `WHERE sandbox_mode IS NULL` guard is suppressed when a pin already
	//    exists, so its reread returns the ACTUAL frozen pin, not the live sandbox.
	try {
		const pinned = await readPin(
			sql,
			organizationId,
			agentId,
			platform,
			conversationId,
		);
		if (pinned) return pinned;
	} catch {
		// Fall through to the upsert path — it re-reads the real pin if one exists.
	}

	// 2. Unpinned: resolve the agent's current sandbox selection. Use the THROWING
	//    resolve — a DB failure here must NOT be frozen (freezing a failed lookup
	//    to builtin would permanently misroute a provider-backed conversation),
	//    and must NOT pin a guessed realm. Let it propagate so the dispatch caller
	//    retries the turn once the DB recovers.
	const live = await resolveAgentRuntimeSelection(agentId, organizationId);
	const frozen = freezeSelection(live);

	// 3. Durably pin via an UPSERT — so the pin survives even when the best-effort
	//    dual-write hasn't landed the conversations row yet (otherwise an absent
	//    row would leave the turn unpinned, and a later turn could resolve a
	//    different realm after an agent repoint — violating immutability). INSERT
	//    the row-with-pin if absent; on conflict, CAS-pin ONLY when still unpinned
	//    (sandbox_mode IS NULL) so the first writer wins and a repoint never
	//    overwrites an existing pin. A racer that lost the conflict gets 0 rows
	//    back (the WHERE guard fails) and re-reads the winner's pin.
	try {
		const rows = (await sql`
      INSERT INTO public.conversations
        (organization_id, agent_id, platform, conversation_id, kind,
         sandbox_mode, sandbox_provider_id, sandbox_id, sandbox_pinned_at)
      VALUES
        (${organizationId}, ${agentId}, ${platform}, ${conversationId}, ${kind},
         ${frozen.mode}, ${frozen.providerId}, ${frozen.sandboxId}, now())
      ON CONFLICT (organization_id, agent_id, platform, conversation_id) DO UPDATE
        SET sandbox_mode = EXCLUDED.sandbox_mode,
            sandbox_provider_id = EXCLUDED.sandbox_provider_id,
            sandbox_id = EXCLUDED.sandbox_id,
            sandbox_pinned_at = now(),
            updated_at = now()
        WHERE public.conversations.sandbox_mode IS NULL
      RETURNING sandbox_mode, sandbox_provider_id, sandbox_id
    `) as PinRow[];
		if (rows[0]) return pinFromRow(rows[0]);
		// 0 rows: a racer pinned first (the DO UPDATE WHERE guard suppressed our
		// write). Re-read the winner's pin.
		const reread = await readPin(
			sql,
			organizationId,
			agentId,
			platform,
			conversationId,
		);
		if (reread) return reread;
	} catch (err) {
		// Both the pin read AND the upsert/reread errored (a DB outage). We can't
		// read the frozen realm and can't durably pin, so ANY value we return risks
		// running an existing pinned conversation in the wrong realm — builtin is
		// still "not the pinned realm". The only correct action is to STOP the turn:
		// throw, which the dispatch caller (message-consumer handleMessage) turns
		// into an OrchestratorError → queue retry. The turn re-runs once the DB
		// recovers and reads/pins the real realm — it never executes in a wrong one.
		throw err;
	}
	// Unreachable: the upsert returns our pin, the racer's pin (reread), or throws
	// (handled above). Throw defensively rather than silently pick a realm.
	throw new Error(
		"resolvePinnedSelection: unreachable — pin upsert returned no row and did not throw",
	);
}

/** The pin columns both the read and the upsert-RETURNING project. */
type PinRow = {
	sandbox_mode: string;
	sandbox_provider_id: string | null;
	sandbox_id: string | null;
};

/**
 * Read an existing (non-null) pin for one conversation, or null if unpinned.
 * Shared by the fast-path read and the post-CAS reread so the SELECT + row shape
 * live in one place.
 */
async function readPin(
	sql: ReturnType<typeof getDb>,
	organizationId: string,
	agentId: string,
	platform: string,
	conversationId: string,
): Promise<AgentRuntimeSelection | null> {
	const rows = (await sql`
    SELECT sandbox_mode, sandbox_provider_id, sandbox_id
    FROM public.conversations
    WHERE organization_id = ${organizationId} AND agent_id = ${agentId}
      AND platform = ${platform} AND conversation_id = ${conversationId}
      AND sandbox_mode IS NOT NULL
    LIMIT 1
  `) as PinRow[];
	return rows[0] ? pinFromRow(rows[0]) : null;
}

/** Reconstruct an AgentRuntimeSelection from a pinned conversations row. */
function pinFromRow(row: PinRow): AgentRuntimeSelection {
	if (row.sandbox_mode === "provider" && row.sandbox_provider_id) {
		return {
			runtimeProviderId: row.sandbox_provider_id,
			sandboxId: row.sandbox_id ?? undefined,
		};
	}
	// 'builtin' → local just-bash.
	return {};
}
