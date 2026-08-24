import { type DbClient, getDb } from "../../db/client.js";

/** Read the latest completed transcript snapshot for one conversation. */
export async function readSnapshotJsonl(args: {
	agentId: string;
	organizationId: string | undefined;
	conversationId: string;
	/** Keep completion read + append on the caller's transaction snapshot. */
	client?: DbClient;
}): Promise<string | null> {
	const { agentId, organizationId, conversationId } = args;
	if (!organizationId) return null;

	const sql = args.client ?? getDb();
	const rows = await sql<{ snapshot_jsonl: string }>`
    SELECT snapshot_jsonl
    FROM public.agent_transcript_snapshot
    WHERE organization_id = ${organizationId}
      AND agent_id = ${agentId}
      AND conversation_id = ${conversationId}
      AND terminal_status = 'completed'
    ORDER BY run_id DESC
    LIMIT 1
  `;
	return rows[0]?.snapshot_jsonl ?? null;
}
