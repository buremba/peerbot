import {
	Actions,
	type CardChild,
	type CardElement,
	CardText,
	type LinkButtonElement,
} from "chat";
import { escapeSlackText } from "../utils/slack-text";

export type ActionOrigin = {
	kind: "automation" | "conversation" | "direct";
	label: string;
};

export type ActionResolution = {
	status:
		| "approved"
		| "rejected"
		| "denied"
		| "answered"
		| "expired";
	actorName?: string | null;
	resolvedAt?: string | Date | null;
	detail?: string | null;
};

function bounded(value: string, max = 240): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > max
		? `${normalized.slice(0, max - 1)}…`
		: normalized;
}

export function actionOriginLabel(kind: ActionOrigin["kind"]): string {
	return kind === "automation"
		? "Automation"
		: kind === "conversation"
			? "Conversation"
			: "Source";
}

export function actionOriginSubtitle(
	origin: ActionOrigin | null | undefined,
): string | undefined {
	if (!origin?.label.trim()) return undefined;
	return `${actionOriginLabel(origin.kind)}: ${escapeSlackText(bounded(origin.label))}`;
}

export function addActionOrigin(
	card: CardElement,
	origin: ActionOrigin | null | undefined,
): CardElement {
	const source = actionOriginSubtitle(origin);
	if (!source) return card;
	return {
		...card,
		subtitle: card.subtitle ? `${card.subtitle} · ${source}` : source,
	};
}

export function formatUtc(value: string | Date | null | undefined): string | null {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	const iso = date.toISOString();
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function actionResolutionText(resolution: ActionResolution): string {
	let text = `*${resolution.status.charAt(0).toUpperCase()}${resolution.status.slice(1)}*`;
	if (resolution.actorName?.trim()) {
		text += ` by ${escapeSlackText(bounded(resolution.actorName))}`;
	}
	const timestamp = formatUtc(resolution.resolvedAt);
	if (timestamp) text += ` · ${timestamp}`;
	if (resolution.detail?.trim()) {
		text += `\n${escapeSlackText(bounded(resolution.detail, 900))}`;
	}
	return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isCard(value: unknown): value is CardElement {
	return (
		isRecord(value) && value.type === "card" && Array.isArray(value.children)
	);
}

/**
 * Turn an interactive card into its terminal receipt. All mutating controls
 * disappear together; ordinary links survive so the audit record remains one
 * click away. This is intentionally generic so approvals, tool grants, and
 * one-shot questions cannot each invent a different stale-button policy.
 */
export function settleActionCard(
	card: CardElement,
	resolution: ActionResolution,
): CardElement {
	const children: CardChild[] = [];
	const trailingLinks: LinkButtonElement[] = [];
	for (const child of card.children) {
		if (!isRecord(child) || child.type !== "actions") {
			children.push(child);
			continue;
		}
		const actionChildren = Array.isArray(child.children) ? child.children : [];
		const links = actionChildren.flatMap((action) => {
			if (!isRecord(action) || action.type !== "link-button") return [];
			if (typeof action.label !== "string" || typeof action.url !== "string") {
				return [];
			}
			return [
				{
					type: "link-button" as const,
					...(typeof action.id === "string" ? { id: action.id } : {}),
					label:
						action.label === "Review in Lobu" ? "View in Lobu" : action.label,
					url: action.url,
				},
			];
		});
		trailingLinks.push(...links);
	}
	children.push(CardText(actionResolutionText(resolution)));
	if (trailingLinks.length > 0) children.push(Actions(trailingLinks));
	return { ...card, children };
}
