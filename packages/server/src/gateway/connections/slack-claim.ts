import type { SlackPendingInstall } from "../../lobu/stores/slack-installations.js";
import type { ClaimAuthorization, ClaimProvider } from "./connection-claim.js";
import type { SlackWebApi } from "./slack-web.js";

/**
 * The Slack adapter for the provider-agnostic claim engine (see
 * `connection-claim.ts`). Slack is the first consumer: a Slack-initiated
 * (marketplace) install lands as an org-less `pending` row (see
 * `writeSlackPendingInstall`); the engine binds it to the claiming user's org
 * once THIS adapter's `authorize` verdict passes and the user confirms.
 *
 * Authority is the Slack workspace-admin check — NOT a secret link token. The
 * install DM carries a convenience deep-link, but a signed-in admin of the
 * workspace can always connect a pending install for their team; a missing,
 * stale, or already-used link never blocks them. This module owns ONLY the
 * provider half: what a Slack pending install is, Slack idempotency, the
 * workspace-admin authority verdict, and the bind. The org-resolution half and
 * the confirm-before-bind two-phase live in the engine.
 */

/** The Slack-specific dependencies the adapter needs (injected for testing). */
export interface SlackClaimProviderDeps {
  /** The parked pending install for a workspace, or null if none. */
  resolvePending(team: string): Promise<SlackPendingInstall | null>;
  /** The org slug the workspace is ALREADY connected to (active install), or null. */
  resolveActiveOrgSlug(team: string): Promise<string | null>;
  /**
   * ALL of the claiming user's `slack_user_id` identities as `{teamId, slackUserId}`
   * pairs (bare `U…` ids, across every workspace they've signed in with Slack for).
   * A team-scoped match doubles as the workspace-membership proof; the full list
   * also lets a Grid org-admin who never joined the workspace prove identity via
   * `slackUserId == pending.installerUserId` (see `authorize`).
   */
  resolveClaimerSlackIdentities(
    userId: string,
  ): Promise<Array<{ teamId: string; slackUserId: string }>>;
  /** `users.info` admin/owner flags for the claimer. */
  usersInfo: SlackWebApi["usersInfo"];
  /** Bind: persist the token + create the active install, returning its id. */
  claim(
    pending: SlackPendingInstall,
    organizationId: string,
  ): Promise<{ installationId: string }>;
}

/**
 * The Slack workspace-admin authority verdict, factored out of the former
 * `resolveClaimTarget` VERBATIM. Authority: the caller must have signed in with
 * Slack for the team (membership) AND be an admin/owner — OR (Grid only) be the
 * install's `installerUserId`.
 */
async function authorizeSlackClaim(
  deps: SlackClaimProviderDeps,
  userId: string,
  pending: SlackPendingInstall,
): Promise<ClaimAuthorization> {
  const identities = await deps.resolveClaimerSlackIdentities(userId);
  // The claimer's `U…` id for THIS workspace, if they've signed in with Slack
  // for it — both proves workspace membership and gives us their id for the
  // admin check. `slack_user_id` identities are stored uppercased.
  const teamPrefix = pending.teamId.toUpperCase();
  const bareUserId =
    identities.find((i) => i.teamId.toUpperCase() === teamPrefix)?.slackUserId ??
    null;

  // Path 1 — workspace membership + admin: signed in with Slack for THIS
  // workspace AND a workspace admin/owner. The canonical authority.
  if (bareUserId) {
    const info = await deps.usersInfo(pending.botToken, bareUserId);
    if (info.isAdmin || info.isOwner) {
      return { status: "authorized", subjectName: pending.teamName };
    }
    return { status: "not_authorized", code: "not_admin" };
  }
  // Path 2 — Grid installer-identity match. A Grid org-admin can provision the
  // workspace without ever joining it, so they have no team-scoped identity
  // and Slack's `admin.teams` is not in our bot scope. But Slack already gated
  // the Grid install action to someone with install authority, and Grid `U…`
  // ids are enterprise-GLOBAL — so a claimer whose OIDC-signed `U…` id equals
  // `pending.installerUserId` is a Slack-signed proof of the same person.
  // STRICTLY Grid-gated (`enterpriseId` non-null): plain workspaces let ANY
  // non-admin install apps, so installer-match must NOT grant authority there
  // (the authority model is admin-not-installer).
  if (
    pending.enterpriseId &&
    pending.installerUserId &&
    identities.some((i) => i.slackUserId === pending.installerUserId)
  ) {
    return { status: "authorized", subjectName: pending.teamName };
  }
  // No workspace identity and no installer match — they never signed in with
  // Slack for this workspace, so we can't run the admin check.
  return { status: "signin_required", signinProvider: "slack" };
}

/**
 * Build the Slack `ClaimProvider` over the injected Slack deps. `bind` maps the
 * engine's `{bindingId}` contract onto Slack's `{installationId}`; the workspace
 * `team` id is the engine's provider-agnostic `ref`.
 */
export function slackClaimProvider(
  deps: SlackClaimProviderDeps,
): ClaimProvider<SlackPendingInstall> {
  return {
    provider: "slack",
    subjectKind: "workspace",
    resolvePending: (ref) => deps.resolvePending(ref),
    resolveExistingBinding: async (ref) => {
      const orgSlug = await deps.resolveActiveOrgSlug(ref);
      return orgSlug ? { orgSlug } : null;
    },
    authorize: (userId, pending) => authorizeSlackClaim(deps, userId, pending),
    bind: async (pending, organizationId) => {
      const { installationId } = await deps.claim(pending, organizationId);
      return { bindingId: installationId };
    },
  };
}
