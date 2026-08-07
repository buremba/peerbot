/**
 * The one name for "this turn is executing a Behavior", shared by the site
 * that stamps it and the sites that read it back off the signed worker token.
 *
 * A Behavior run is dispatched with `intent.kind === "behavior_run"`; the
 * enqueue path (routes/public/agent.ts) turns that into
 * `platformMetadata.source = "watcher-run"`, which `buildWorkerTokenClaims`
 * lifts into the token as `WorkerTokenData.source`. `watcher` is the internal
 * engine vocabulary for a Behavior, so the wire value keeps its historical
 * spelling — nothing agent-facing reads it.
 *
 * What reading it back means: the turn's job text is the FROZEN instruction
 * set saved on the Behavior version, not a human's message. That freeze is only
 * honest if the agent's live skill *library* stays out of the turn: the worker
 * receives the version's pinned skill snapshots instead. Persona, tools, MCP
 * and network stay live; they are the agent, not the job.
 *
 * Narrower than the SSE-routing notion of "headless": connector-repair,
 * scheduled-job and internal turns have no frozen Behavior text behind them,
 * so suppressing their skills would only make them dumber. Ordinary chat is
 * excluded for the same reason even when a Behavior is listening on the
 * conversation — a human is in that thread and the library is theirs.
 *
 * Why the worker's 5-minute session-context cache needs no isolation key: a
 * Behavior run opens its own session (`thread: watcher-<runId>`, `forceNew`,
 * see `watchers/automation.ts`), and the deployment name hashes the
 * conversation id — so a run's worker process is never the process that also
 * serves that agent's chat. If a future dispatch path ever runs a Behavior on
 * a shared conversation, that cache becomes the place this decision leaks.
 */

import type { DbClient } from "../db/client.js";
import { getDb } from "../db/client.js";
import {
	type BehaviorSkillSnapshot,
	parseBehaviorSkillSnapshots,
} from "../behaviors/skill-snapshots.js";
import { parseBehaviorRunConversationId } from "./permissions/behavior-run-intent.js";
import { BEHAVIOR_RUN_TYPES_PG } from "../runs/run-types.js";

export const BEHAVIOR_RUN_SOURCE = "watcher-run";

export type BehaviorRunSkillResolver = (args: {
	conversationId: string;
	organizationId: string | undefined;
	agentId: string | undefined;
}) => Promise<BehaviorSkillSnapshot[]>;

/**
 * Resolve the exact version pinned on a Behavior run. The org, agent, Behavior,
 * and run correlations all come from signed worker-token claims; keep every one
 * in the query so a malformed token can never read another tenant's snapshots.
 *
 * Missing or malformed durable state fails closed. Returning an empty list for
 * a missing row would let a skills-only Behavior execute without instructions.
 */
export async function resolveBehaviorRunSkills(
	args: Parameters<BehaviorRunSkillResolver>[0],
	db: DbClient = getDb(),
): Promise<BehaviorSkillSnapshot[]> {
	const intent = parseBehaviorRunConversationId(args.conversationId);
	if (!intent || !args.organizationId || !args.agentId) {
		throw new Error("Behavior run token is missing its pinned-skill scope");
	}

	const rows = await db`
		SELECT version.skills
		FROM runs behavior_run
		JOIN watchers behavior
		  ON behavior.id = behavior_run.watcher_id
		 AND behavior.organization_id = behavior_run.organization_id
		 AND behavior.agent_id = ${args.agentId}
		JOIN watcher_versions version
		  ON version.id = COALESCE(
		       NULLIF(behavior_run.approved_input->>'version_id', '')::bigint,
		       behavior.current_version_id
		     )
		 AND version.watcher_id = behavior.watcher_group_id
		WHERE behavior_run.id = ${intent.runId}
		  AND behavior_run.run_type = ANY(${BEHAVIOR_RUN_TYPES_PG}::text[])
		  AND behavior_run.watcher_id = ${intent.behaviorId}
		  AND behavior_run.organization_id = ${args.organizationId}
		LIMIT 1
	`;
	if (rows.length !== 1) {
		throw new Error("Behavior run's pinned version was not found");
	}
	return parseBehaviorSkillSnapshots(rows[0]?.skills);
}

export function formatBehaviorRunSkillInstructions(
	skills: readonly BehaviorSkillSnapshot[],
): string {
	if (skills.length === 0) return "";
	return [
		"## Pinned Behavior skills",
		"",
		"Read every skill below before performing this Behavior's task. These files are frozen to this run's version; do not substitute similarly named skills.",
		"",
		...skills.map((skill) => `- \`${skill.name}\`: \`.skills/${skill.name}/SKILL.md\``),
	].join("\n");
}
