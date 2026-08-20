/**
 * Human-only gate for `connection.config.action_modes`.
 *
 * The per-connection approval overrides are the control surface unattended
 * runs execute UNDER: `resolveActionMode` consults
 * `connection.config.action_modes` BEFORE the connector's `requiresApproval`
 * default, so a principal that can write the map can grant itself `auto` on
 * e.g. `os.shell` `run` and erase the approval gate for its own actions.
 * `manage_connections` create/update are member-tier, and an agent's MCP
 * session carries its user's membership (`syncAgentBinding` stamps `agentId`
 * on an authenticated session), so membership alone cannot carry this
 * decision.
 *
 * Same identity rule as operation-run approvals (`resolve_approval` /
 * `approve_batch`, see manage_operations/handlers/approvals.ts): any agent,
 * OAuth-client, or MCP-transport identity on the context — or no verified
 * user at all — is not a human decision-maker here. Everything else about a
 * connection stays agent-editable; only the modes map is fenced.
 */

import type { ToolContext } from "../../../registry";
import { getActionModes } from "../../../../operations/action-modes";

/** Canonical, order-independent fingerprint of a config's sanitized modes. */
function actionModesFingerprint(
	config: Record<string, unknown> | null | undefined,
): string {
	const modes = getActionModes(config);
	return JSON.stringify(
		Object.entries(modes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

/** True when the write would change the effective (sanitized) modes map. */
export function actionModesChanged(
	before: Record<string, unknown> | null | undefined,
	after: Record<string, unknown> | null | undefined,
): boolean {
	return actionModesFingerprint(before) !== actionModesFingerprint(after);
}

/** True when the config carries any effective (sanitized) mode at all. */
export function hasActionModes(
	config: Record<string, unknown> | null | undefined,
): boolean {
	return Object.keys(getActionModes(config)).length > 0;
}

const ACTION_MODES_HUMAN_ONLY_ERROR =
	"Changing action_modes (per-operation approval overrides) requires a human web session. " +
	"Agents cannot change approval modes — edit them in the web UI, on the " +
	"connection's settings tab or the connector's defaults page.";

/**
 * Returns the denial for a non-human context, or null for a genuine human.
 * Call only when the write actually touches the modes map (changed on update,
 * present on create / connect / connector defaults).
 *
 * Rejecting `clientId` alone would not be enough: an automation reaction runs
 * with `userId: null` and no agent or client id (see
 * `automations/reaction-executor.ts`), so a machine-marker-only check would
 * wave it through. `update` happens to stop it earlier ("you can only update
 * connections you created"), but create / connect / connector defaults have no
 * such fence — verified by dropping the `!ctx.userId` clause, which lets a
 * reaction plant modes on all three. Require a positive human identity, not
 * merely the absence of a machine one.
 */
export function denyNonHumanActionModesWrite(
	ctx: ToolContext,
): { error: string } | null {
	if (ctx.agentId || ctx.clientId || ctx.mcpSessionId || !ctx.userId) {
		return { error: ACTION_MODES_HUMAN_ONLY_ERROR };
	}
	return null;
}
