import { createHash } from "node:crypto";
import type { SlackPendingInstall } from "../../lobu/stores/slack-installations.js";
import type { SlackWebApi } from "./slack-web.js";

/**
 * The marketplace-claim decision, factored out of the HTTP route so it is
 * unit-testable without booting the server. A Slack-initiated (marketplace)
 * install lands as an org-less `pending` row (see `writeSlackPendingInstall`);
 * this binds it to the claiming user's org once they prove they (a) hold the
 * single-use claim token, (b) signed in with Slack for the workspace, and (c)
 * are a workspace admin/owner. Every dependency is injected so the route can
 * wire the real stores and tests can stub them; nothing here touches HTTP,
 * Postgres, or the network directly.
 *
 * Split into two phases so the UI can CONFIRM the destination org before
 * binding: `resolveSlackClaimContext` runs the authorization guards and returns
 * the workspace + the claimer's eligible orgs (no write); `claimSlackWorkspace`
 * re-runs the guards and binds to the org the user explicitly chose. Binding a
 * whole workspace's data to an org is a decision, so it is never implicit.
 */

/** Shared authorization error statuses (each maps to an HTTP code in the route). */
export type SlackClaimError =
  | { status: "unauthenticated" }
  | { status: "invalid_request" }
  | { status: "no_pending_install" }
  | { status: "invalid_token" }
  | { status: "slack_signin_required" }
  | { status: "not_admin" }
  | { status: "not_member_of_org" }
  | { status: "no_org" }
  | { status: "claim_failed"; message: string };

/** Terminal outcome of the bind (`claimSlackWorkspace`). */
export type SlackClaimResult =
  | { status: "ok"; orgSlug: string | null; installationId: string }
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
  | SlackClaimError;

export interface SlackClaimDeps {
  /** The parked pending install for a workspace, or null if none. */
  resolvePending(team: string): Promise<SlackPendingInstall | null>;
  /**
   * The claiming user's bare `U…` Slack id for this workspace (from their
   * team-scoped `slack_user_id` identity), or null if they never signed in with
   * Slack for it.
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
 * Run the claim authorization guards (token hash → Slack sign-in → workspace
 * admin) WITHOUT binding. Returns the pending install on success so callers can
 * bind or preview.
 */
async function authorizeClaim(
  deps: SlackClaimDeps,
  input: { userId: string | null; team: string; token: string },
): Promise<{ status: "ready"; pending: SlackPendingInstall } | SlackClaimError> {
  if (!input.userId) return { status: "unauthenticated" };
  if (!input.team || !input.token) return { status: "invalid_request" };

  const pending = await deps.resolvePending(input.team);
  if (!pending) return { status: "no_pending_install" };

  // Validate the presented token against the stored sha256 hash. A null hash
  // (no claim link was ever minted) is unclaimable via this path.
  const presentedHash = createHash("sha256").update(input.token).digest("hex");
  if (!pending.claimTokenHash || presentedHash !== pending.claimTokenHash) {
    return { status: "invalid_token" };
  }

  // The claimer must have signed in with Slack for THIS workspace, so we hold
  // their team-scoped slack_user_id — the UI prompts sign-in on this code.
  const bareUserId = await deps.resolveClaimerSlackId(input.userId, input.team);
  if (!bareUserId) return { status: "slack_signin_required" };

  // …and be a workspace admin/owner to bind the whole workspace.
  const info = await deps.usersInfo(pending.botToken, bareUserId);
  if (!info.isAdmin && !info.isOwner) return { status: "not_admin" };

  return { status: "ready", pending };
}

/**
 * Confirmation context: run the guards and return the workspace name + the
 * claimer's eligible orgs, so the UI can show "Connect <workspace> to <org>"
 * before any write. No mutation.
 */
export async function resolveSlackClaimContext(
  deps: SlackClaimDeps,
  input: { userId: string | null; team: string; token: string },
): Promise<SlackClaimContext> {
  try {
    const authz = await authorizeClaim(deps, input);
    if (authz.status !== "ready") return authz;
    const orgs = await deps.resolveMemberOrgs(input.userId as string);
    if (orgs.length === 0) return { status: "no_org" };
    return { status: "ready", workspaceName: authz.pending.teamName, orgs };
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
 * omitted (programmatic callers), falls back to the user's default org.
 */
export async function claimSlackWorkspace(
  deps: SlackClaimDeps,
  input: {
    userId: string | null;
    team: string;
    token: string;
    organizationId?: string;
  },
): Promise<SlackClaimResult> {
  try {
    const authz = await authorizeClaim(deps, input);
    if (authz.status !== "ready") return authz;

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

    const { installationId } = await deps.claim(authz.pending, organizationId);
    const orgSlug = await deps.resolveOrgSlug(organizationId);
    return { status: "ok", orgSlug, installationId };
  } catch (err) {
    return {
      status: "claim_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
