import type { SlackPendingInstall } from "../../lobu/stores/slack-installations.js";
import type { SlackWebApi } from "./slack-web.js";

/**
 * The marketplace-claim decision, factored out of the HTTP route so it is
 * unit-testable without booting the server. A Slack-initiated (marketplace)
 * install lands as an org-less `pending` row (see `writeSlackPendingInstall`);
 * this binds it to the claiming user's org once they prove they (a) signed in
 * with Slack for the workspace and (b) are a workspace admin/owner.
 *
 * Authority is the Slack workspace-admin check — NOT a secret link token. The
 * install DM carries a convenience deep-link, but a signed-in admin of the
 * workspace can always connect a pending install for their team; a missing,
 * stale, or already-used link never blocks them. Split into two phases so the
 * UI can CONFIRM the destination org before binding: `resolveSlackClaimContext`
 * runs the guards + returns the workspace and eligible orgs (no write);
 * `claimSlackWorkspace` binds to the org the user chose. Every dependency is
 * injected so the route can wire real stores and tests can stub them.
 */

/** Shared authorization error statuses (each maps to an HTTP code in the route). */
export type SlackClaimError =
  | { status: "unauthenticated" }
  | { status: "invalid_request" }
  | { status: "no_pending_install" }
  | { status: "slack_signin_required" }
  | { status: "not_admin" }
  | { status: "not_member_of_org" }
  | { status: "no_org" }
  | { status: "claim_failed"; message: string };

/** Terminal outcome of the bind (`claimSlackWorkspace`). */
export type SlackClaimResult =
  | {
      status: "ok";
      orgSlug: string | null;
      installationId: string;
      /** True when the workspace was already connected (idempotent no-op). */
      alreadyConnected?: boolean;
    }
  | SlackClaimError;

/** A Lobu org the claimer may bind the workspace into. */
export interface ClaimEligibleOrg {
  id: string;
  slug: string;
  name: string;
}

/** Confirmation context for the UI (`resolveSlackClaimContext`). */
export type SlackClaimContext =
  | {
      status: "ready";
      /** Human-readable workspace name for the confirm copy. */
      workspaceName: string | null;
      /** Orgs the claimer belongs to (the destination picker). */
      orgs: ClaimEligibleOrg[];
    }
  | {
      // The workspace is already connected — the UI links to it instead of
      // showing a scary "not found" error for a re-visited/spent link.
      status: "already_connected";
      orgSlug: string | null;
    }
  | SlackClaimError;

export interface SlackClaimDeps {
  /** The parked pending install for a workspace, or null if none. */
  resolvePending(team: string): Promise<SlackPendingInstall | null>;
  /** The org slug the workspace is ALREADY connected to (active install), or null. */
  resolveActiveOrgSlug(team: string): Promise<string | null>;
  /**
   * The claiming user's bare `U…` Slack id for this workspace (from their
   * team-scoped `slack_user_id` identity), or null if they never signed in with
   * Slack for it. Doubles as the workspace-membership proof.
   */
  resolveClaimerSlackId(userId: string, team: string): Promise<string | null>;
  /** `users.info` admin/owner flags for the claimer. */
  usersInfo: SlackWebApi["usersInfo"];
  /** The orgs the claimer is a member of (the destination picker). */
  resolveMemberOrgs(userId: string): Promise<ClaimEligibleOrg[]>;
  /**
   * Resolve an explicitly chosen org (slug or id) to its id IFF the user is a
   * member, else null. Guards the confirm step so a user can only bind into an
   * org they belong to.
   */
  resolveOrgIfMember(userId: string, orgSlugOrId: string): Promise<string | null>;
  /** The claiming user's default org, when they didn't pick one explicitly. */
  resolveDefaultOrgId(userId: string): Promise<string | null>;
  /** Bind: persist the token + create the active install, returning its id. */
  claim(
    pending: SlackPendingInstall,
    organizationId: string,
  ): Promise<{ installationId: string }>;
  /** The org's URL slug (for the success redirect), or null. */
  resolveOrgSlug(organizationId: string): Promise<string | null>;
}

/**
 * Run the claim authorization guards WITHOUT binding. Authority is the Slack
 * workspace-admin check: the caller must have signed in with Slack for the team
 * (membership) and be an admin/owner. Returns the pending install on success, a
 * distinct `already_connected` when the workspace is already bound, or an error.
 */
async function resolveClaimTarget(
  deps: SlackClaimDeps,
  input: { userId: string | null; team: string },
): Promise<
  | { status: "ready"; pending: SlackPendingInstall }
  | { status: "already_connected"; orgSlug: string | null }
  | SlackClaimError
> {
  if (!input.userId) return { status: "unauthenticated" };
  if (!input.team) return { status: "invalid_request" };

  // The claimer must have signed in with Slack for THIS workspace — that both
  // proves workspace membership and gives us their `U…` id for the admin check.
  const bareUserId = await deps.resolveClaimerSlackId(input.userId, input.team);
  if (!bareUserId) return { status: "slack_signin_required" };

  const pending = await deps.resolvePending(input.team);
  if (pending) {
    // Must be a workspace admin/owner to bind the whole workspace.
    const info = await deps.usersInfo(pending.botToken, bareUserId);
    if (!info.isAdmin && !info.isOwner) return { status: "not_admin" };
    return { status: "ready", pending };
  }

  // No pending install: either it's already connected (a re-visited/spent link),
  // or Lobu was never installed into this workspace.
  const orgSlug = await deps.resolveActiveOrgSlug(input.team);
  if (orgSlug) return { status: "already_connected", orgSlug };
  return { status: "no_pending_install" };
}

/**
 * Confirmation context: run the guards and return the workspace name + the
 * claimer's eligible orgs, so the UI can show "Connect <workspace> to <org>"
 * before any write. Surfaces `already_connected` for a workspace that's already
 * bound. No mutation.
 */
export async function resolveSlackClaimContext(
  deps: SlackClaimDeps,
  input: { userId: string | null; team: string },
): Promise<SlackClaimContext> {
  try {
    const target = await resolveClaimTarget(deps, input);
    if (target.status !== "ready") return target;
    const orgs = await deps.resolveMemberOrgs(input.userId as string);
    if (orgs.length === 0) return { status: "no_org" };
    return { status: "ready", workspaceName: target.pending.teamName, orgs };
  } catch (err) {
    return {
      status: "claim_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Bind the pending workspace into the org the user CONFIRMED. `organizationId`
 * (slug or id) is required from the confirm step; it is membership-verified. When
 * omitted (programmatic callers), falls back to the user's default org. An
 * already-connected workspace resolves to an idempotent success pointing at its
 * existing org.
 */
export async function claimSlackWorkspace(
  deps: SlackClaimDeps,
  input: {
    userId: string | null;
    team: string;
    organizationId?: string;
  },
): Promise<SlackClaimResult> {
  try {
    const target = await resolveClaimTarget(deps, input);
    if (target.status === "already_connected") {
      return {
        status: "ok",
        orgSlug: target.orgSlug,
        installationId: "",
        alreadyConnected: true,
      };
    }
    if (target.status !== "ready") return target;

    // Resolve the destination org: the explicitly chosen one (membership-checked)
    // or the user's default. Binding a workspace is never implicit — the UI sends
    // the confirmed org here.
    let organizationId: string | null;
    if (input.organizationId) {
      organizationId = await deps.resolveOrgIfMember(
        input.userId as string,
        input.organizationId,
      );
      if (!organizationId) return { status: "not_member_of_org" };
    } else {
      organizationId = await deps.resolveDefaultOrgId(input.userId as string);
    }
    if (!organizationId) return { status: "no_org" };

    const { installationId } = await deps.claim(target.pending, organizationId);
    const orgSlug = await deps.resolveOrgSlug(organizationId);
    return { status: "ok", orgSlug, installationId };
  } catch (err) {
    return {
      status: "claim_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
