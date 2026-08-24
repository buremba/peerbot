/**
 * Vocabulary of the `icon` field on a Lobu view. Shared with Owletto's
 * `InteractionView` icon union: the client authors its own cards for the
 * message/tool/memory kinds, so every member has a producer even when the
 * server only stamps a subset onto durable approvals.
 */
export const ApprovalKind = {
	Approval: "approval",
	Connector: "connector",
	EntitySchema: "entity-schema",
	Entity: "entity",
	Agent: "agent",
	Automation: "automation",
	Message: "message",
	Tool: "tool",
	Question: "question",
	Memory: "memory",
} as const;

export type ApprovalKind = (typeof ApprovalKind)[keyof typeof ApprovalKind];

export type ApprovalImpact = {
	level: "normal" | "high";
	reason?: string;
	consequences?: string[];
};

type ApprovalContext = {
	kind: ApprovalKind;
	impact: ApprovalImpact;
};

const APPROVAL_KINDS = new Set<string>(Object.values(ApprovalKind));

function isApprovalKind(value: unknown): value is ApprovalKind {
	return typeof value === "string" && APPROVAL_KINDS.has(value);
}

export function normalApprovalImpact(): ApprovalImpact {
	return { level: "normal" };
}

export function highApprovalImpact(
	reason: string,
	consequences?: string[],
): ApprovalImpact {
	return {
		level: "high",
		reason,
		...(consequences?.length ? { consequences } : {}),
	};
}

export function approvalContext(
	kind: ApprovalKind,
	impact: ApprovalImpact = normalApprovalImpact(),
): { approval_context: ApprovalContext } {
	return { approval_context: { kind, impact } };
}

export function readApprovalContext(value: unknown): ApprovalContext | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const context = value as Record<string, unknown>;
	if (!isApprovalKind(context.kind)) return null;
	if (
		!context.impact ||
		typeof context.impact !== "object" ||
		Array.isArray(context.impact)
	) {
		return null;
	}
	const impact = context.impact as Record<string, unknown>;
	if (impact.level !== "normal" && impact.level !== "high") return null;
	if (impact.reason !== undefined && typeof impact.reason !== "string") {
		return null;
	}
	if (
		impact.consequences !== undefined &&
		(!Array.isArray(impact.consequences) ||
			!impact.consequences.every((item) => typeof item === "string"))
	) {
		return null;
	}
	return {
		kind: context.kind,
		impact: {
			level: impact.level,
			...(typeof impact.reason === "string" ? { reason: impact.reason } : {}),
			...(Array.isArray(impact.consequences)
				? { consequences: impact.consequences as string[] }
				: {}),
		},
	};
}
