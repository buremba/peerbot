import type { ToolContext } from "../tools/registry";
import { ToolUserError } from "../utils/errors";
import {
	type McpAppCapabilityBinding,
	canIssueMcpAppCapability,
	isMcpAppCapabilityBinding,
	issueMcpAppCapability,
	mcpAppCapabilityMatchesHost,
	readMcpAppCapability,
} from "../tools/mcp-app-capability";

export const TEMPLATE_ACTION_CAPABILITY_META_KEY =
	"lobu/event-action-capability";
const TEMPLATE_ACTION_CAPABILITY_TTL_MS = 10 * 60 * 1_000;
const MAX_TEMPLATE_ACTION_SOURCE_EVENTS = 200;

type TemplateActionCapability = {
	v: 1;
	sourceEventIds: number[];
};

function isTemplateActionCapability(
	value: unknown,
): value is TemplateActionCapability & McpAppCapabilityBinding {
	if (!isMcpAppCapabilityBinding(value)) return false;
	const payload = value as McpAppCapabilityBinding & {
		v?: unknown;
		sourceEventIds?: unknown;
	};
	return (
		payload.v === 1 &&
		Array.isArray(payload.sourceEventIds) &&
		payload.sourceEventIds.length > 0 &&
		payload.sourceEventIds.length <= MAX_TEMPLATE_ACTION_SOURCE_EVENTS &&
		payload.sourceEventIds.every(
			(id) => Number.isSafeInteger(id) && Number(id) > 0,
		)
	);
}

export { canIssueMcpAppCapability as canIssueTemplateActionCapability };

export function issueTemplateActionCapability(
	sourceEventIds: number[],
	ctx: ToolContext & {
		userId: string;
		clientId: string;
		mcpSessionId: string;
	},
): string {
	const normalizedSourceEventIds = [...new Set(sourceEventIds)].sort(
		(a, b) => a - b,
	);
	if (
		normalizedSourceEventIds.length === 0 ||
		normalizedSourceEventIds.length > MAX_TEMPLATE_ACTION_SOURCE_EVENTS ||
		!normalizedSourceEventIds.every((id) => Number.isSafeInteger(id) && id > 0)
	) {
		throw new Error(
			`Template action capabilities require 1-${MAX_TEMPLATE_ACTION_SOURCE_EVENTS} positive integer source event ids.`,
		);
	}
	return issueMcpAppCapability(
		{
			v: 1,
			sourceEventIds: normalizedSourceEventIds,
		},
		ctx,
		TEMPLATE_ACTION_CAPABILITY_TTL_MS,
	);
}

export function assertTemplateActionCapability(
	token: string | null | undefined,
	sourceEventId: number,
	ctx: ToolContext,
): void {
	const capability = readMcpAppCapability(token);
	if (
		!isTemplateActionCapability(capability) ||
		!capability.sourceEventIds.includes(sourceEventId) ||
		capability.organizationId !== ctx.organizationId ||
		!mcpAppCapabilityMatchesHost(capability, ctx)
	) {
		throw new ToolUserError(
			"A valid MCP App event-action capability is required.",
			403,
		);
	}
}
