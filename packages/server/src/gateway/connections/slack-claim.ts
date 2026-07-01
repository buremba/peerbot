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
 */

/** Discriminated outcome — the route maps each `status` to an HTTP code. */
export type SlackClaimResult =
  | { status: "ok"; orgSlug: string | null; installationId: string }
  | { status: "unauthenticated" }
  | { status: "invalid_request" }
  | { status: "no_pending_install" }
  | { status: "invalid_token" }
  | { status: "slack_signin_required" }
  | { status: "not_admin" }
  | { status: "no_org" }
  | { status: "claim_failed"; message: string };

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
  /** The claiming user's default org to bind into, or null if they have none. */
  resolveDefaultOrgId(userId: string): Promise<string | null>;
  /** Bind: persist the token + create the active install, returning its id. */
  claim(
    pending: SlackPendingInstall,
    organizationId: string,
  ): Promise<{ installationId: string }>;
  /** The org's URL slug (for the success redirect), or null. */
  resolveOrgSlug(organizationId: string): Promise<string | null>;
}

export async function claimSlackWorkspace(
  deps: SlackClaimDeps,
  input: { userId: string | null; team: string; token: string },
): Promise<SlackClaimResult> {
  if (!input.userId) return { status: "unauthenticated" };
  if (!input.team || !input.token) return { status: "invalid_request" };

  try {
    const pending = await deps.resolvePending(input.team);
    if (!pending) return { status: "no_pending_install" };

    // Validate the presented token against the stored sha256 hash. A null hash
    // (no claim link was ever minted) is unclaimable via this path.
    const presentedHash = createHash("sha256")
      .update(input.token)
      .digest("hex");
    if (!pending.claimTokenHash || presentedHash !== pending.claimTokenHash) {
      return { status: "invalid_token" };
    }

    // The claimer must have signed in with Slack for THIS workspace, so we hold
    // their team-scoped slack_user_id — the UI prompts sign-in on this code.
    const bareUserId = await deps.resolveClaimerSlackId(
      input.userId,
      input.team,
    );
    if (!bareUserId) return { status: "slack_signin_required" };

    // …and be a workspace admin/owner to bind the whole workspace.
    const info = await deps.usersInfo(pending.botToken, bareUserId);
    if (!info.isAdmin && !info.isOwner) return { status: "not_admin" };

    const organizationId = await deps.resolveDefaultOrgId(input.userId);
    if (!organizationId) return { status: "no_org" };

    const { installationId } = await deps.claim(pending, organizationId);
    const orgSlug = await deps.resolveOrgSlug(organizationId);
    return { status: "ok", orgSlug, installationId };
  } catch (err) {
    return {
      status: "claim_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
