/**
 * Starter-chip generation — the hidden "starters" turn.
 *
 * Starter chips are the suggested first actions shown BEFORE a conversation
 * begins (a fresh draft has no server conversation yet), generated per agent+org
 * by an agent that inspects the real workspace state via its own tools. This
 * module dispatches that hidden turn: it opens a throwaway thread and enqueues a
 * single instruction telling the agent to call `suggest_actions` once and finish.
 * The turn runs with `source: "starters"`, which (a) exempts it from the SSE
 * owner-gate (HEADLESS_SOURCES), (b) makes the worker skip its transcript
 * snapshot (no visible message), and (c) routes its `suggest_actions` post to
 * the per-agent cache (see interactions route).
 *
 * Dispatch is debounced with a durable Postgres lease per agent+org across all
 * replicas. The lease token is the hidden turn's message id, so only that turn
 * can publish or fail its generation. It outlives this request and expires if
 * the worker never reaches a terminal response.
 */
import { randomUUID } from "node:crypto";
import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";
import type { QueueProducer } from "../infrastructure/queue/queue-producer.js";
import {
	createThreadForAgent,
	enqueueAgentMessage,
} from "../services/agent-threads.js";
import type { ISessionManager } from "../session.js";
import {
	readCachedStarters,
	shouldRegenerate,
	STARTERS_LEASE_PREFIX,
} from "./starter-store.js";

const logger = createLogger("generate-starters");

const STARTERS_LEASE_MS = 15 * 60 * 1000;

/**
 * Read-only tools the hidden starters turn may use.
 *
 * `strictMode` filters ONLY the built-in tool set (createLobuTools: read /
 * write / edit / bash — see session-runner.ts). Plugin and MCP tools are
 * registered separately and are NOT filtered by this list, so naming a plugin
 * tool here does not grant it and omitting one does not revoke it.
 *
 * That is exactly what we want: the turn keeps its workspace-inspection MCP
 * tools and `suggest_actions` (both plugin-side) while every filesystem and
 * shell primitive is dropped. Listing only plugin names here — as a first cut
 * did — silently yielded `tools=0`, which reads like a lockdown but is really
 * "no built-in matched any name".
 */
export const STARTERS_ALLOWED_TOOLS = ["read"];

/**
 * The hidden instruction enqueued for a starters turn. The agent inspects the
 * workspace itself — no authored copy, no static examples baked in here.
 */
const STARTER_PROMPT = [
	"This is a hidden setup turn — no user is watching and your reply text is",
	"discarded (only the suggested actions you post are kept). Inspect this",
	"workspace using your own tools (query the connections, entities, and recent",
	"data available to you). Then call `suggest_actions` EXACTLY ONCE with 3-4",
	"excellent first things this user could ask you, tailored to what actually",
	"exists here. If the workspace is empty (no connections, entities, or data),",
	"suggest concrete onboarding steps (connect a data source, import entities,",
	"etc.). Do not ask the user anything, do not call `suggest_actions` more than",
	"once, and finish immediately after that single call.",
].join(" ");

/**
 * Ensure a fresh starter set exists for (agentId, org): if the cache is stale or
 * missing, dispatch a hidden starters turn to (re)generate it. Fire-and-forget
 * from the landing pull — never awaited on the LLM. No-op (returns false) when
 * another replica holds the durable generation lease or the cache turned fresh
 * after this request acquired it.
 */
export async function ensureStarters(
	deps: { sessionManager: ISessionManager; queueProducer: QueueProducer },
	args: { agentId: string; organizationId: string },
): Promise<boolean> {
	const { agentId, organizationId } = args;
	const sql = getDb();
	const leaseKey = `${organizationId}:${agentId}`;
	const messageId = randomUUID();
	const claimed = await sql<{ token: string }>`
    INSERT INTO chat_state_locks (
      key_prefix, thread_id, token, expires_at
    ) VALUES (
      ${STARTERS_LEASE_PREFIX}, ${leaseKey}, ${messageId},
      now() + ${STARTERS_LEASE_MS} * interval '1 millisecond'
    )
    ON CONFLICT (key_prefix, thread_id) DO UPDATE
      SET token = EXCLUDED.token,
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
      WHERE chat_state_locks.expires_at <= now()
    RETURNING token
  `;
	if (claimed.length === 0) return false;

	const releaseLease = async () => {
		await sql`
      DELETE FROM chat_state_locks
      WHERE key_prefix = ${STARTERS_LEASE_PREFIX}
        AND thread_id = ${leaseKey}
        AND token = ${messageId}
    `;
	};

	try {
		// A concurrent generation may have landed between the endpoint's stale
		// read and this lease claim. Release immediately instead of suppressing the
		// next legitimate regeneration for the full cooldown.
		const cached = await readCachedStarters(organizationId, agentId);
		if (!shouldRegenerate(cached)) {
			await releaseLease();
			return false;
		}

		const { threadId } = await createThreadForAgent(deps, {
			agentId,
			organizationId,
			reason: "starters",
		});
		await enqueueAgentMessage(deps, {
			threadId,
			messageId,
			messageText: STARTER_PROMPT,
			source: "starters",
			// This is an automatic background turn. Keep it structurally
			// read-only even if the agent normally has mutating tools.
			allowedTools: STARTERS_ALLOWED_TOOLS,
		});

		logger.info(
			`Dispatched starters turn for agent ${agentId} (thread ${threadId})`,
		);
		return true;
	} catch (err) {
		await releaseLease();
		throw err;
	}
}
