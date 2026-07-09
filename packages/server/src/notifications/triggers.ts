import { Actions, Button, Card, CardText, LinkButton } from "chat";
import { getDb } from "../db/client";
import { emit } from "../events/emitter";
import { buildResourcePermalink } from "../utils/url-builder";
import { createNotificationForUsers } from "./service";

/** Notification content minus the org id (the dispatch helpers stamp it). */
type OrgNotification = Omit<
	Parameters<typeof createNotificationForUsers>[1],
	"organizationId"
>;

type FieldChangeApprovalDetails = {
	kind: "entity_field_change";
	actorLabel?: string | null;
	entityId?: number | null;
	entityType?: string | null;
	entityName?: string | null;
	entityUrl?: string | null;
	fields: Record<string, unknown>;
	current?: Record<string, unknown> | null;
	reason?: string | null;
};

type EntityChangeApprovalDetails = {
	kind: "entity_change";
	operation: "create" | "delete";
	actorLabel?: string | null;
	entityId?: number | null;
	entityType?: string | null;
	entityName?: string | null;
	entityUrl?: string | null;
	proposal?: Record<string, unknown> | null;
	current?: Record<string, unknown> | null;
	reason?: string | null;
};

export type ActionApprovalDetails =
	| FieldChangeApprovalDetails
	| EntityChangeApprovalDetails;

/**
 * Escape user/agent-controlled text before it lands in Slack mrkdwn (and the
 * in-app Markdown body — both render HTML entities). Without this, a proposed
 * field value containing `<!channel>` pings the room from inside a trusted
 * approval card, and `<https://evil|Review in Lobu>` spoofs the review link.
 */
function escapeNotificationText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function displayNotificationValue(value: unknown): string {
	if (value === undefined || value === null || value === "") return "Not set";
	if (typeof value === "string") return escapeNotificationText(value);
	return escapeNotificationText(JSON.stringify(value, null, 2));
}

function truncateNotificationLine(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 480
		? `${normalized.slice(0, 477)}...`
		: normalized;
}

/** "$parent_id" → "Parent id", "entity_type" → "Entity type". */
export function formatLabel(value: string): string {
	return value
		.replace(/^\$/, "")
		.replace(/[_-]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^./, (char) => char.toUpperCase());
}

/** "Update topic fields: Severity, Name" — shared with the propose path. */
export function formatFieldChangeAction(
	entityType: string | null | undefined,
	fields: string[],
): string {
	const fieldList = fields.map(formatLabel).join(", ") || "field";
	const fieldNoun = fields.length === 1 ? "field" : "fields";
	const entityLabel = entityType
		? formatLabel(entityType).toLowerCase()
		: "entity";
	return `Update ${entityLabel} ${fieldNoun}: ${fieldList}`;
}

function formatReviewLink(url: string): string {
	return `[Review in Lobu](${url})`;
}

function formatCardLink(label: string, url: string): string {
	return `<${url}|${escapeNotificationText(label.replace(/[<>|]/g, ""))}>`;
}

function compactDiffLine(
	currentValue: unknown,
	proposedValue: unknown,
): string {
	const current = truncateNotificationLine(
		displayNotificationValue(currentValue),
	);
	const proposed = truncateNotificationLine(
		displayNotificationValue(proposedValue),
	);
	return `~${current}~\n→ ${proposed}`;
}

function formatWhyApprovalNeeded(reason: string | null | undefined): string {
	// Neutral fallback: this card also fires for org-policy gates (admin said
	// "updates need approval"), not only the human-owned-field guard.
	const fallback =
		"This change needs a human approval before it is applied.";
	if (!reason) return fallback;
	return escapeNotificationText(
		reason.replace(/^Watcher proposes updating /i, "Field is protected: "),
	);
}

export function formatActionApprovalTitle(
	actionKey: string,
	details?: ActionApprovalDetails,
): string {
	if (details?.kind === "entity_field_change") {
		return formatFieldChangeAction(
			details.entityType,
			Object.keys(details.fields),
		).replace(/^Update /, "Review ");
	}
	if (details?.kind === "entity_change") {
		const entityLabel = details.entityType
			? formatLabel(details.entityType).toLowerCase()
			: "entity";
		return details.operation === "delete"
			? `Review deleting ${entityLabel}`
			: `Review creating ${entityLabel}`;
	}
	return `Action "${actionKey}" needs approval`;
}

/**
 * Format-neutral content of an approval card, computed ONCE for both surfaces
 * (in-app Markdown body and Slack mrkdwn card): escaping, truncation, labels,
 * diff lines, and the "why" sentence live here; the two emitters below only
 * decide bolding, link syntax, and blank-line placement.
 */
interface ApprovalRenderModel {
	requestedBy: string | null;
	entityName: string | null;
	entityUrl: string | null;
	entityId: number | null;
	/** formatLabel(entityType), for the body's entity-link fallback. */
	entityTypeLabel: string | null;
	/** Field-change diffs (null for entity_change — kinds render differently). */
	diffs: Array<{ label: string; diff: string }> | null;
	/** entity_change action sentence ("Create/Delete this entity"). */
	action: string | null;
	proposal: Array<{ label: string; value: string }>;
	/** Fully formatted "why" text; null omits the section. */
	why: string | null;
}

function buildApprovalRenderModel(
	details: ActionApprovalDetails,
): ApprovalRenderModel {
	const base = {
		requestedBy: details.actorLabel
			? escapeNotificationText(details.actorLabel)
			: null,
		entityName: details.entityName ?? null,
		entityUrl: details.entityUrl ?? null,
		entityId: details.entityId ?? null,
		entityTypeLabel: details.entityType ? formatLabel(details.entityType) : null,
	};
	if (details.kind === "entity_field_change") {
		const current = details.current ?? {};
		return {
			...base,
			diffs: Object.entries(details.fields).map(([field, proposed]) => ({
				label: formatLabel(field),
				diff: compactDiffLine(current[field], proposed),
			})),
			action: null,
			proposal: [],
			why: formatWhyApprovalNeeded(details.reason),
		};
	}
	return {
		...base,
		diffs: null,
		action:
			details.operation === "delete"
				? "Delete this entity"
				: "Create this entity",
		proposal: Object.entries(details.proposal ?? {}).map(([field, value]) => ({
			label: formatLabel(field),
			value: truncateNotificationLine(displayNotificationValue(value)),
		})),
		why: details.reason ? escapeNotificationText(details.reason) : null,
	};
}

/**
 * In-app Markdown body. Kept tight — the structured approval card (with the
 * Approve/Reject buttons) is the primary surface; this body is the scannable
 * one-glance summary above it: WHO wants to do WHAT to WHICH entity, the diff,
 * and one review link. No "Requested by:/Proposed action:/Why approval is
 * needed:" scaffolding — a single natural sentence carries it.
 */
function renderApprovalBody(
	model: ApprovalRenderModel,
	approvalUrl?: string,
): string {
	const lines: string[] = [];
	const label = escapeNotificationText(
		model.entityName ?? model.entityTypeLabel ?? "this entity",
	);
	const entityLink = model.entityUrl
		? `[${label}](${model.entityUrl})`
		: model.entityId
			? `${label} (#${model.entityId})`
			: label;
	const who = model.requestedBy ?? "A watcher";

	// One summary line: "<Watcher> wants to <verb> <entity>."
	if (model.diffs) {
		lines.push(`**${who}** wants to update ${entityLink}:`);
		for (const d of model.diffs) lines.push(`- ${d.label}: ${d.diff}`);
	} else {
		const verb = model.action === "Delete this entity" ? "delete" : "create";
		lines.push(`**${who}** wants to ${verb} ${entityLink}.`);
		if (model.proposal.length > 0) {
			for (const p of model.proposal) lines.push(`- ${p.label}: ${p.value}`);
		}
	}
	// The proposer's own reason, inline and unlabeled (it reads as a sentence).
	if (model.why) lines.push("", model.why);
	if (approvalUrl) lines.push("", formatReviewLink(approvalUrl));
	return lines.join("\n");
}

/** Slack mrkdwn card text (bold labels, `<url|label>` links). */
function renderApprovalCardText(model: ApprovalRenderModel): string {
	const lines: string[] = [];
	if (model.requestedBy) lines.push(`*Requested by:* ${model.requestedBy}`);
	if (model.entityName) {
		lines.push(
			`*Entity:* ${
				model.entityUrl
					? formatCardLink(model.entityName, model.entityUrl)
					: escapeNotificationText(model.entityName)
			}`,
		);
	}
	if (model.diffs) {
		for (const d of model.diffs) lines.push("", `*${d.label}*`, d.diff);
	}
	if (model.action) {
		lines.push("", `*Proposed action:* ${model.action}`);
		for (const p of model.proposal) lines.push(`*${p.label}:* ${p.value}`);
	}
	if (model.why) lines.push("", `*Why approval is needed:* ${model.why}`);
	return lines.join("\n");
}

export function formatActionApprovalBody(params: {
	connectionName?: string;
	approvalUrl?: string;
	details?: ActionApprovalDetails;
}): string {
	if (
		params.details?.kind === "entity_field_change" ||
		params.details?.kind === "entity_change"
	) {
		return renderApprovalBody(
			buildApprovalRenderModel(params.details),
			params.approvalUrl,
		);
	}

	const connLabel = params.connectionName ? ` on ${params.connectionName}` : "";
	const urlLine = params.approvalUrl
		? `\n\nReview: ${formatReviewLink(params.approvalUrl)}`
		: "";
	return `A queued action${connLabel} is waiting for your review.${urlLine}`;
}

export function buildActionApprovalCard(params: {
	runId?: number;
	approvalUrl?: string;
	details?: ActionApprovalDetails;
}) {
	if (
		!params.details ||
		!["entity_field_change", "entity_change"].includes(params.details.kind)
	)
		return undefined;
	const cardText = renderApprovalCardText(
		buildApprovalRenderModel(params.details),
	);

	const actions = [];
	if (params.runId) {
		actions.push(
			Button({
				id: `run-approval:${params.runId}:approve`,
				label: "Approve",
				style: "primary",
				value: "approve",
			}),
		);
		actions.push(
			Button({
				id: `run-approval:${params.runId}:reject`,
				label: "Reject",
				style: "danger",
				value: "reject",
			}),
		);
	}
	if (params.approvalUrl) {
		actions.push(
			LinkButton({ url: params.approvalUrl, label: "Review in Lobu" }),
		);
	}

	return Card({
		children: [
			CardText(cardText),
			...(actions.length > 0 ? [Actions(actions)] : []),
		],
	});
}

async function getOrgAdminUserIds(organizationId: string): Promise<string[]> {
	const sql = getDb();
	const rows = await sql<{ userId: string }>`
    SELECT "userId"
    FROM "member"
    WHERE "organizationId" = ${organizationId}
      AND role IN ('admin', 'owner')
  `;
	return rows.map((r) => r.userId);
}

async function getOrgSlug(organizationId: string): Promise<string | null> {
	const sql = getDb();
	const rows = await sql<{ slug: string }>`
    SELECT slug FROM "organization" WHERE id = ${organizationId} LIMIT 1
  `;
	return rows[0]?.slug ?? null;
}

/**
 * Shared trigger tail: write the notification for the resolved recipients and
 * poke the org's SSE keys so inboxes refresh. Every trigger below ends here;
 * what varies is recipient resolution — admins (with the org slug fetched for
 * URL building) vs an explicit user — kept explicit per trigger.
 */
async function sendNotification(
	orgId: string,
	userIds: string[],
	notification: OrgNotification,
): Promise<void> {
	await createNotificationForUsers(userIds, {
		organizationId: orgId,
		...notification,
	});
	emit(orgId, { keys: ["notifications", "notifications-unread-count"] });
}

/**
 * Admin-recipient triggers: resolve the org's admins/owners (no-op when there
 * are none — the slug isn't fetched either), then build the notification with
 * the org slug available for resource URLs.
 */
async function notifyOrgAdmins(
	orgId: string,
	build: (orgSlug: string | null) => OrgNotification,
): Promise<void> {
	const adminIds = await getOrgAdminUserIds(orgId);
	if (adminIds.length === 0) return;

	const orgSlug = await getOrgSlug(orgId);
	await sendNotification(orgId, adminIds, build(orgSlug));
}

export async function notifyActionApprovalNeeded(params: {
	orgId: string;
	runId: number;
	actionKey: string;
	connectionName?: string;
	eventId?: number;
	approvalUrl?: string;
	connectionId?: string | null;
	channelId?: string | null;
	teamId?: string | null;
	/** Field owner — routes the Slack card to their DM before the channel tier. */
	ownerUserId?: string | null;
	details?: ActionApprovalDetails;
}): Promise<void> {
	await notifyOrgAdmins(params.orgId, (orgSlug) => {
		// Run-scoped, via the shared permalink resolver — same reasoning as the
		// approval_url: the pending event is superseded on approve→complete, but the
		// run link stays valid across the chain. (baseUrl omitted → relative link,
		// which the inbox resolves against the current origin.)
		const resourceUrl = buildResourcePermalink(orgSlug, {
			kind: "run",
			runId: params.runId,
		});
		return {
			type: "action_approval_needed",
			title: formatActionApprovalTitle(params.actionKey, params.details),
			body: formatActionApprovalBody(params),
			card: buildActionApprovalCard({
				runId: params.runId,
				approvalUrl: params.approvalUrl,
				details: params.details,
			}),
			resourceType: "event",
			resourceId: params.eventId
				? String(params.eventId)
				: String(params.runId),
			resourceUrl,
			connectionId: params.connectionId,
			channelId: params.channelId,
			teamId: params.teamId,
			ownerUserId: params.ownerUserId,
		};
	});
}

export async function notifyConnectionPermissionRequest(params: {
	orgId: string;
	connectionId: number;
	connectorKey: string;
	connectUrl?: string;
}): Promise<void> {
	await notifyOrgAdmins(params.orgId, (orgSlug) => {
		const urlLine = params.connectUrl
			? `\n\nAuthorize: ${params.connectUrl}`
			: "";
		return {
			type: "connection_permission_request",
			title: `Connection "${params.connectorKey}" needs authorization`,
			body: `A new connection was created and requires OAuth authorization.${urlLine}`,
			resourceType: "connection",
			resourceId: String(params.connectionId),
			resourceUrl: orgSlug ? `/${orgSlug}/connectors` : undefined,
		};
	});
}

export async function notifyBrowserAuthExpired(params: {
	orgId: string;
	connectionId: number;
	connectorKey: string;
	/**
	 * Set for connectors that store a `browser_session` auth profile (the CLI /
	 * Mac browser-auth capture flow). Omitted for extension-scrape connectors
	 * (e.g. Revolut, LinkedIn) that reuse the live browser session and have no
	 * stored auth profile — those just need the user to re-login on the site.
	 */
	authProfileSlug?: string | null;
}): Promise<void> {
	await notifyOrgAdmins(params.orgId, (orgSlug) => ({
		type: "browser_auth_expired",
		title: `${params.connectorKey} needs sign-in`,
		body: params.authProfileSlug
			? "Session needs re-authentication.\n" +
				"Enable remote debugging in Chrome: chrome://inspect/#remote-debugging\n" +
				`Or run: lobu memory browser-auth --connector ${params.connectorKey} --auth-profile-slug ${params.authProfileSlug}`
			: `Your ${params.connectorKey} session has expired, so syncing has stopped. ` +
				`Open ${params.connectorKey} in the browser where your Owletto extension runs and sign in to resume.`,
		resourceType: "connection",
		resourceId: String(params.connectionId),
		resourceUrl: orgSlug ? `/${orgSlug}/connectors` : undefined,
	}));
}

export async function notifyInvitationReceived(params: {
	orgId: string;
	userId: string;
	orgName: string;
	inviterName?: string;
}): Promise<void> {
	const inviterLabel = params.inviterName ? ` by ${params.inviterName}` : "";
	await sendNotification(params.orgId, [params.userId], {
		type: "invitation_received",
		title: `You've been invited to ${params.orgName}`,
		body: `You were invited${inviterLabel} to join the organization.`,
		resourceType: "organization",
		resourceId: params.orgId,
	});
}
