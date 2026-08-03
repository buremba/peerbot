import { getDb } from "../../../db/client";
import {
	getOrgAppInstallationMethod,
	resolveAppInstallCredentials,
} from "../../../gateway/installation/app-install-credentials";
import { buildConnectionsUrl } from "../../../utils/url-builder";
import { isAdminOrOwnerRole } from "../../access-control";
import type { ToolContext } from "../../registry";
import type {
	ManageConnectionsResult,
} from "../manage_connections/schemas";
import type { ConnectorSetupError } from "./connector-setup-errors";

interface CrossWorkspaceConnectionRow {
	source_installation_id: number;
	organization_id: string;
	organization_slug: string;
	organization_name: string;
	connection_id: number | null;
	connection_slug: string | null;
	display_name: string | null;
	source_member_role: string;
}

function hasVisibleConnection(
	row: CrossWorkspaceConnectionRow,
): row is CrossWorkspaceConnectionRow & {
	connection_id: number;
	connection_slug: string;
} {
	return row.connection_id !== null && row.connection_slug !== null;
}

export async function buildCrossWorkspaceAppInstallResult(params: {
	connectorKey: string;
	ctx: ToolContext;
	setup: ConnectorSetupError;
	setupContinuation: ManageConnectionsResult;
	ownerSlug: string | null;
	baseUrl: string | undefined;
}): Promise<ManageConnectionsResult> {
	const {
		connectorKey,
		ctx,
		setup,
		setupContinuation,
		ownerSlug,
		baseUrl,
	} = params;
	const { organizationId, userId } = ctx;
	if (
		!userId ||
		(ctx.tokenType !== "oauth" && ctx.tokenType !== "session") ||
		connectorKey !== "github" ||
		setup.provider !== "github" ||
		setup.install_shape !== "github-app" ||
		!setup.provider_instance ||
		!ownerSlug ||
		!("install_url" in setupContinuation) ||
		typeof setupContinuation.install_url !== "string"
	) {
		return setupContinuation;
	}

	// GitHub transfer validation uses the configured App id as part of the exact
	// installation identity. Apply the same predicate during discovery so every
	// offered transfer option can pass that later validation.
	const method = await getOrgAppInstallationMethod(
		organizationId,
		connectorKey,
		setup.provider,
	);
	const providerAppId = method
		? resolveAppInstallCredentials(method).appId
		: undefined;
	if (!providerAppId) return setupContinuation;

	// Installations remain workspace-scoped. Include an active install when the
	// caller administers its workspace even if its connection was deleted; attach
	// only a connection the caller could see when one still exists.
	const sql = getDb();
	const otherRows = (await sql`
		SELECT ai.id AS source_installation_id,
		       o.id AS organization_id, o.slug AS organization_slug,
		       o.name AS organization_name, c.id AS connection_id,
		       c.slug AS connection_slug, c.display_name,
		       m.role AS source_member_role
		FROM "member" m
		JOIN organization o ON o.id = m."organizationId"
		JOIN app_installations ai ON ai.organization_id = o.id
		LEFT JOIN LATERAL (
		  SELECT candidate.id, candidate.slug, candidate.display_name
		  FROM connections candidate
		  WHERE candidate.organization_id = o.id
		    AND candidate.connector_key = ${connectorKey}
		    AND candidate.status = 'active'
		    AND candidate.deleted_at IS NULL
		    AND candidate.config ->> 'installation_ref' = ai.id::text
		    AND (
		      m.role IN ('owner', 'admin')
		      OR candidate.visibility = 'org'
		      OR candidate.created_by = ${userId}
		    )
		  ORDER BY candidate.id ASC
		  LIMIT 1
		) c ON TRUE
		WHERE m."userId" = ${userId}
		  AND o.id <> ${organizationId}
		  AND ai.status = 'active'
		  AND ai.provider = ${setup.provider}
		  AND ai.provider_instance = ${setup.provider_instance}
		  AND ai.provider_app_id = ${providerAppId}
		  AND (c.id IS NOT NULL OR m.role IN ('owner', 'admin'))
		ORDER BY o.slug ASC, ai.id ASC
	`) as unknown as CrossWorkspaceConnectionRow[];
	if (otherRows.length === 0) return setupContinuation;

	// A malformed configured gateway URL must not turn setup guidance into a
	// tool failure. The plain continuation remains actionable for configuration.
	let installUrl: URL;
	try {
		installUrl = new URL(setupContinuation.install_url);
	} catch {
		return setupContinuation;
	}
	installUrl.searchParams.set("org", ownerSlug);

	const currentRows = (await sql`
		SELECT name FROM organization WHERE id = ${organizationId} LIMIT 1
	`) as unknown as Array<{ name: string }>;
	const canTransferTarget = isAdminOrOwnerRole(ctx.memberRole);
	const transferOptions = canTransferTarget
		? otherRows
				.filter((row) => isAdminOrOwnerRole(row.source_member_role))
				.map((row) => {
					const transferUrl = new URL(installUrl);
					transferUrl.searchParams.set("recovery", "1");
					transferUrl.searchParams.set("confirm_transfer", "1");
					transferUrl.searchParams.set(
						"source_installation_id",
						String(row.source_installation_id),
					);
					return {
						source_workspace: {
							id: row.organization_id,
							slug: row.organization_slug,
						},
						source_installation_id: row.source_installation_id,
						transfer_url: transferUrl.toString(),
					};
				})
		: [];
	const accessibleWorkspaces = otherRows
		.filter(hasVisibleConnection)
		.map((row) => ({
			workspace: {
				id: row.organization_id,
				slug: row.organization_slug,
				name: row.organization_name,
			},
			connection: {
				id: Number(row.connection_id),
				slug: row.connection_slug,
				display_name: row.display_name,
				status: "active" as const,
			},
			switch_workspace: {
				next_action: "switch_workspace" as const,
				organization_id: row.organization_id,
				organization_slug: row.organization_slug,
				view_url: buildConnectionsUrl(
					row.organization_slug,
					baseUrl,
					connectorKey,
				),
			},
		}));
	const locationInstructions =
		accessibleWorkspaces.length > 0
			? "This connector is already active in another workspace you can access. Switch to that workspace or install a different provider tenant here."
			: "This GitHub App installation is active in another workspace you administer. Install a different provider tenant here.";

	return {
		action: "connect",
		status: "connected_in_other_workspace",
		connector_key: connectorKey,
		current_workspace: {
			id: organizationId,
			slug: ownerSlug,
			name: currentRows[0]?.name ?? ownerSlug,
		},
		accessible_workspaces: accessibleWorkspaces,
		install_app_here: {
			next_action: "install_app",
			install_url: installUrl.toString(),
		},
		...("setup_attempt_id" in setupContinuation &&
		typeof setupContinuation.setup_attempt_id === "string"
			? { setup_attempt_id: setupContinuation.setup_attempt_id }
			: {}),
		...("completion_check" in setupContinuation &&
		setupContinuation.completion_check
			? { completion_check: setupContinuation.completion_check }
			: {}),
		...(transferOptions.length > 0
			? {
					transfer_installation_here: {
						next_action: "transfer_installation_here" as const,
						requires_confirmation: true as const,
						warning:
							"Each option moves one exact GitHub App installation here and revokes the source-workspace connections bound to it.",
						options: transferOptions,
					},
				}
			: {}),
		instructions: `${locationInstructions}${transferOptions.length > 0 ? " To move one exact installation, use its explicit transfer option; owner/admin rights are required in both workspaces." : ""} No connection data or credentials are shared across workspaces.`,
	};
}
