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

type ActionApprovalDetails =
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

function formatLabel(value: string): string {
	return value
		.replace(/^\$/, "")
		.replace(/[_-]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^./, (char) => char.toUpperCase());
}

function formatFieldChangeAction(details: FieldChangeApprovalDetails): string {
	const fields = Object.keys(details.fields);
	const fieldList = fields.map(formatLabel).join(", ") || "field";
	const fieldNoun = fields.length === 1 ? "field" : "fields";
	const entityLabel = details.entityType
		? formatLabel(details.entityType).toLowerCase()
		: "entity";
	return `Update ${entityLabel} ${fieldNoun}: ${fieldList}`;
}

function formatFieldChangeReviewTitle(
	details: FieldChangeApprovalDetails,
): string {
	return formatFieldChangeAction(details).replace(/^Update /, "Review ");
}

function formatReviewLink(url: string): string {
	return `[Review in Lobu](${url})`;
}

function formatEntityLink(details: FieldChangeApprovalDetails): string | null {
	const label = escapeNotificationText(
		details.entityName ??
			(details.entityType ? formatLabel(details.entityType) : "Entity"),
	);
	if (details.entityUrl) return `[${label}](${details.entityUrl})`;
	if (details.entityId) return `${label} (#${details.entityId})`;
	return details.entityName ? label : null;
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

function formatActionApprovalTitle(
	actionKey: string,
	details?: ActionApprovalDetails,
): string {
	if (details?.kind === "entity_field_change") {
		return formatFieldChangeReviewTitle(details);
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

function formatActionApprovalBody(params: {
	connectionName?: string;
	approvalUrl?: string;
	details?: ActionApprovalDetails;
}): string {
	if (params.details?.kind === "entity_field_change") {
		const details = params.details;
		const lines: string[] = [];
		if (details.actorLabel)
			lines.push(`Requested by: ${escapeNotificationText(details.actorLabel)}`);
		const entityLink = formatEntityLink(details);
		if (entityLink) lines.push(`Entity: ${entityLink}`);

		lines.push("", "Proposed change:");
		const current = details.current ?? {};
		for (const [field, proposed] of Object.entries(details.fields)) {
			lines.push(`${formatLabel(field)}:`);
			lines.push(compactDiffLine(current[field], proposed));
		}

		lines.push(
			"",
			`Why approval is needed: ${formatWhyApprovalNeeded(details.reason)}`,
		);
		if (params.approvalUrl) {
			lines.push("", `Review: ${formatReviewLink(params.approvalUrl)}`);
		}
		return lines.join("\n");
	}

	if (params.details?.kind === "entity_change") {
		const details = params.details;
		const lines: string[] = [];
		if (details.actorLabel)
			lines.push(`Requested by: ${escapeNotificationText(details.actorLabel)}`);
		const entityLink = formatEntityLink({
			kind: "entity_field_change",
			actorLabel: details.actorLabel,
			entityId: details.entityId,
			entityType: details.entityType,
			entityName: details.entityName,
			entityUrl: details.entityUrl,
			fields: {},
		});
		if (entityLink) lines.push(`Entity: ${entityLink}`);

		if (details.operation === "delete") {
			lines.push("", "Proposed action: Delete this entity");
		} else {
			lines.push("", "Proposed action: Create this entity");
		}
		if (details.proposal && Object.keys(details.proposal).length > 0) {
			lines.push("");
			for (const [field, value] of Object.entries(details.proposal)) {
				lines.push(
					`${formatLabel(field)}: ${truncateNotificationLine(displayNotificationValue(value))}`,
				);
			}
		}
		if (details.reason)
			lines.push(
				"",
				`Why approval is needed: ${escapeNotificationText(details.reason)}`,
			);
		if (params.approvalUrl) {
			lines.push("", `Review: ${formatReviewLink(params.approvalUrl)}`);
		}
		return lines.join("\n");
	}

	const connLabel = params.connectionName ? ` on ${params.connectionName}` : "";
	const urlLine = params.approvalUrl
		? `\n\nReview: ${formatReviewLink(params.approvalUrl)}`
		: "";
	return `A queued action${connLabel} is waiting for your review.${urlLine}`;
}

function buildActionApprovalCard(params: {
	runId?: number;
	approvalUrl?: string;
	details?: ActionApprovalDetails;
}) {
	if (
		!params.details ||
		!["entity_field_change", "entity_change"].includes(params.details.kind)
	)
		return undefined;
	const details = params.details;
	const lines: string[] = [];
	if (details.actorLabel)
		lines.push(`*Requested by:* ${escapeNotificationText(details.actorLabel)}`);
	if (details.entityName) {
		const entityLabel = details.entityUrl
			? formatCardLink(details.entityName, details.entityUrl)
			: escapeNotificationText(details.entityName);
		lines.push(`*Entity:* ${entityLabel}`);
	}

	if (details.kind === "entity_field_change") {
		const current = details.current ?? {};
		for (const [field, proposed] of Object.entries(details.fields)) {
			lines.push("");
			lines.push(`*${formatLabel(field)}*`);
			lines.push(compactDiffLine(current[field], proposed));
		}
	} else {
		lines.push("");
		lines.push(
			details.operation === "delete"
				? "*Proposed action:* Delete this entity"
				: "*Proposed action:* Create this entity",
		);
		if (details.proposal && Object.keys(details.proposal).length > 0) {
			for (const [field, value] of Object.entries(details.proposal)) {
				lines.push(
					`*${formatLabel(field)}:* ${truncateNotificationLine(displayNotificationValue(value))}`,
				);
			}
		}
	}

	if (details.kind === "entity_field_change" || details.reason) {
		lines.push("");
		lines.push(
			`*Why approval is needed:* ${
				details.kind === "entity_field_change"
					? formatWhyApprovalNeeded(details.reason)
					: escapeNotificationText(details.reason ?? "")
			}`,
		);
	}

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
			CardText(lines.join("\n")),
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
