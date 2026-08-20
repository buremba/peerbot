/**
 * Human-only gate for `connection.config.action_modes`. These overrides run
 * before a connector's `requiresApproval` default, so token, agent, MCP, and
 * userless callers must not be able to grant themselves `auto` execution.
 */

import type { ToolContext } from "../../../registry";
import { getActionModes } from "../../../../operations/action-modes";

function actionModesFingerprint(
	config: Record<string, unknown> | null | undefined,
): string {
	const modes = getActionModes(config);
	return JSON.stringify(
		Object.entries(modes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

export function actionModesChanged(
	before: Record<string, unknown> | null | undefined,
	after: Record<string, unknown> | null | undefined,
): boolean {
	return actionModesFingerprint(before) !== actionModesFingerprint(after);
}

export function hasActionModes(
	config: Record<string, unknown> | null | undefined,
): boolean {
	return Object.keys(getActionModes(config)).length > 0;
}

const ACTION_MODES_HUMAN_ONLY_ERROR =
	"Changing action_modes (per-operation approval overrides) requires a human web session. " +
	"Agents and API tokens cannot change approval modes — edit them in the web UI, on the " +
	"connection's settings tab or the connector's defaults page.";

export function denyNonHumanActionModesWrite(
	ctx: ToolContext,
): { error: string } | null {
	// The same identity rule operation-run approvals enforce (see
	// manage_operations/handlers/approvals.ts): no agent, OAuth-client, or MCP
	// transport identity, and a positive user. PAT and OAuth bearers always
	// carry `clientId` (the PAT verifier stamps `pat_<id>`), so the client
	// marker covers API tokens; `!userId` stops the in-process automation
	// reaction, which runs with no user and no machine marker at all. A
	// stricter `tokenType === 'session'` requirement was tried and rejected:
	// it exceeds the approvals rule this gate is defined by, and it denies
	// nothing real that the client marker does not already deny.
	if (ctx.agentId || ctx.clientId || ctx.mcpSessionId || !ctx.userId) {
		return { error: ACTION_MODES_HUMAN_ONLY_ERROR };
	}
	return null;
}
