/**
 * Provider-agnostic "claim" engine, lifted from the Slack-specific claim flow
 * (see `slackClaimProvider` in `slack-claim.ts`, its first consumer). A
 * marketplace / provider-initiated install lands as an org-less `pending` row;
 * this binds it to the claiming user's org once the provider's authority check
 * passes and the user confirms the destination org.
 *
 * The engine owns the org-resolution half — two-phase confirm-before-bind,
 * idempotent already-connected success, explicit-org membership check, default-
 * org fallback, and the terminal error taxonomy. The PROVIDER owns the authority
 * half: what a pending install is, how idempotency is decided, who is allowed to
 * claim (the `authorize` verdict), and how the bind is persisted. Every
 * dependency is injected so routes wire real stores and tests use a stub
 * provider.
 */

/** Shared authorization error statuses (each maps to an HTTP code in the route). */
export type ClaimError =
  | { status: "unauthenticated" }
  | { status: "invalid_request" }
  | { status: "no_pending" }
  /** The claimer must sign in with `signinProvider` before authority can be checked. */
  | { status: "signin_required"; signinProvider: string }
  /** The provider denied authority; `code` is the provider-specific reason. */
  | { status: "not_authorized"; code: string }
  | { status: "not_member_of_org" }
  | { status: "no_org" }
  | { status: "claim_failed"; message: string };

/** Terminal outcome of the bind (`claimPendingConnection`). */
export type ClaimResult =
  | {
      status: "ok";
      orgSlug: string | null;
      bindingId: string;
      /** True when the subject was already connected (idempotent no-op). */
      alreadyConnected?: boolean;
    }
  | ClaimError;

/** A Lobu org the claimer may bind the subject into. */
export interface ClaimEligibleOrg {
  id: string;
  slug: string;
  name: string;
  /**
   * True when this is the claimer's auto-provisioned personal org (marked by
   * `metadata.personal_org_for_user_id`). Sorted LAST so the UI preselects a
   * team org — a subject should not silently bind into a personal org.
   */
  isPersonal: boolean;
}

/** The provider's verdict on whether `userId` may claim `pending`. */
export type ClaimAuthorization =
  | { status: "authorized"; subjectName: string | null }
  | { status: "signin_required"; signinProvider: string }
  | { status: "not_authorized"; code: string };

/** Confirmation context for the UI (`resolveClaimContext`). */
export type ClaimContext =
  | {
      status: "ready";
      /** Human-readable subject name for the confirm copy. */
      subjectName: string | null;
      /** Orgs the claimer belongs to (the destination picker). */
      orgs: ClaimEligibleOrg[];
    }
  | {
      // The subject is already connected — the UI links to it instead of showing
      // a scary "not found" error for a re-visited/spent link.
      status: "already_connected";
      orgSlug: string | null;
    }
  | ClaimError;

/**
 * The provider half of a claim. `P` is the provider's pending-install shape.
 * Everything here is provider policy: resolving the pending row, deciding
 * idempotency, the authority verdict, and persisting the bind.
 */
export interface ClaimProvider<P = unknown> {
  /** The connector/provider key (e.g. `"slack"`). */
  provider: string;
  /** The kind of subject being claimed (e.g. `"workspace"`, `"account"`). */
  subjectKind: string;
  /** The parked pending install for `ref`, or null if none. */
  resolvePending(ref: string): Promise<P | null>;
  /**
   * The org the subject is ALREADY bound to (active install), or null.
   * Idempotency is provider policy: a non-null result becomes an
   * `already_connected` success rather than an error.
   */
  resolveExistingBinding(ref: string): Promise<{ orgSlug: string | null } | null>;
  /** The provider's authority verdict for the claiming user against `pending`. */
  authorize(userId: string, pending: P): Promise<ClaimAuthorization>;
  /** Bind: persist the token + create the active install, returning its id. */
  bind(
    pending: P,
    organizationId: string,
    userId: string,
  ): Promise<{ bindingId: string }>;
}

/**
 * The org-resolution dependencies the engine owns (lifted verbatim from the
 * former `SlackClaimDeps`). Shared by every provider; wired once per route.
 */
export interface ClaimEngineDeps {
  /** The orgs the claimer is a member of (the destination picker). */
  resolveMemberOrgs(userId: string): Promise<ClaimEligibleOrg[]>;
  /**
   * Resolve an explicitly chosen org (slug or id) to its id IFF the user is a
   * member, else null. Guards the confirm step so a user can only bind into an
   * org they belong to.
   */
  resolveOrgIfMember(userId: string, orgSlugOrId: string): Promise<string | null>;
  /** The org's URL slug (for the success redirect), or null. */
  resolveOrgSlug(organizationId: string): Promise<string | null>;
}

/**
 * Run the claim authorization guards WITHOUT binding, delegating the authority
 * verdict to the provider. Returns the pending install on success, a distinct
 * `already_connected` when the subject is already bound, or an error.
 */
async function resolveClaimTarget<P>(
  provider: ClaimProvider<P>,
  input: { userId: string | null; ref: string },
): Promise<
  | { status: "ready"; pending: P; subjectName: string | null }
  | { status: "already_connected"; orgSlug: string | null }
  | ClaimError
> {
  if (!input.userId) return { status: "unauthenticated" };
  if (!input.ref) return { status: "invalid_request" };

  const pending = await provider.resolvePending(input.ref);
  if (pending) {
    const verdict = await provider.authorize(input.userId, pending);
    if (verdict.status === "authorized") {
      return { status: "ready", pending, subjectName: verdict.subjectName };
    }
    if (verdict.status === "signin_required") {
      return {
        status: "signin_required",
        signinProvider: verdict.signinProvider,
      };
    }
    return { status: "not_authorized", code: verdict.code };
  }

  // No pending install: either it's already connected (a re-visited/spent link),
  // or the app was never installed for this subject.
  const existing = await provider.resolveExistingBinding(input.ref);
  if (existing) {
    return { status: "already_connected", orgSlug: existing.orgSlug };
  }
  return { status: "no_pending" };
}

/**
 * Confirmation context: run the guards and return the subject name + the
 * claimer's eligible orgs, so the UI can show "Connect <subject> to <org>"
 * before any write. Surfaces `already_connected` for a subject that's already
 * bound. No mutation.
 */
export async function resolveClaimContext<P>(
  provider: ClaimProvider<P>,
  deps: ClaimEngineDeps,
  input: { userId: string | null; ref: string },
): Promise<ClaimContext> {
  try {
    const target = await resolveClaimTarget(provider, input);
    if (target.status !== "ready") return target;
    const orgs = await deps.resolveMemberOrgs(input.userId as string);
    if (orgs.length === 0) return { status: "no_org" };
    return { status: "ready", subjectName: target.subjectName, orgs };
  } catch (err) {
    return {
      status: "claim_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Bind the pending subject into the org the user CONFIRMED. `organizationId`
 * (slug or id) is required from the confirm step; it is membership-verified. When
 * omitted (programmatic callers), falls back to the user's default org. An
 * already-connected subject resolves to an idempotent success pointing at its
 * existing org.
 */
export async function claimPendingConnection<P>(
  provider: ClaimProvider<P>,
  deps: ClaimEngineDeps,
  input: {
    userId: string | null;
    ref: string;
    organizationId?: string;
  },
): Promise<ClaimResult> {
  try {
    const target = await resolveClaimTarget(provider, input);
    if (target.status === "already_connected") {
      return {
        status: "ok",
        orgSlug: target.orgSlug,
        bindingId: "",
        alreadyConnected: true,
      };
    }
    if (target.status !== "ready") return target;

    // Binding a subject to an org is NEVER implicit. This flow creates a
    // connection under an org from an EXTERNAL (marketplace/OAuth) request, so
    // the destination org must be an explicit, membership-verified choice the
    // human confirmed on the claim page — never a silent default. A claim with
    // no confirmed org is rejected (`invalid_request`), not routed to the
    // caller's oldest org: that would let an external install create a
    // connection under an org the installer never picked.
    if (!input.organizationId) return { status: "invalid_request" };
    const organizationId = await deps.resolveOrgIfMember(
      input.userId as string,
      input.organizationId,
    );
    if (!organizationId) return { status: "not_member_of_org" };

    const { bindingId } = await provider.bind(
      target.pending,
      organizationId,
      input.userId as string,
    );
    const orgSlug = await deps.resolveOrgSlug(organizationId);
    return { status: "ok", orgSlug, bindingId };
  } catch (err) {
    return {
      status: "claim_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Map a claim/context status to its HTTP code (shared by both routes). */
export function claimHttpStatus(
  status: string,
): 400 | 401 | 403 | 404 | 409 | 500 {
  switch (status) {
    case "unauthenticated":
      return 401;
    case "invalid_request":
      return 400;
    case "no_pending":
      return 404;
    case "signin_required":
    case "not_authorized":
    case "not_member_of_org":
      return 403;
    case "no_org":
      return 409;
    default:
      return 500;
  }
}
