/**
 * Retarget hazard for --include-shared:
 * resolveTenantMember prefers a personal_org_for_user_id tag only when that
 * org also has a live auth:signup $member claim; otherwise it falls back to
 * createdAt ASC among private orgs with claims. Backfilling a claim into an
 * older private shared org without a resolvable tagged personal target would
 * redirect personal identity facts into the shared org.
 */

import { describe, expect, it } from "bun:test";
import { decideSharedPrivateBackfill } from "../backfill-member-claims";

describe("decideSharedPrivateBackfill", () => {
  it("skips shared private orgs by default (no --include-shared)", () => {
    expect(
      decideSharedPrivateBackfill({
        includeShared: false,
        hasResolvableTaggedPersonalOrg: true,
      })
    ).toBe("skip-shared-default");
    expect(
      decideSharedPrivateBackfill({
        includeShared: false,
        hasResolvableTaggedPersonalOrg: false,
      })
    ).toBe("skip-shared-default");
  });

  it("allows --include-shared only with a resolvable tagged personal org", () => {
    expect(
      decideSharedPrivateBackfill({
        includeShared: true,
        hasResolvableTaggedPersonalOrg: true,
      })
    ).toBe("backfill");
  });

  it("refuses --include-shared when there is no resolvable tagged personal org", () => {
    // Covers: no tag at all, AND tagged-but-drifted/blocked (no live claim).
    // Without this skip, resolveTenantMember falls back to createdAt.
    expect(
      decideSharedPrivateBackfill({
        includeShared: true,
        hasResolvableTaggedPersonalOrg: false,
      })
    ).toBe("skip-no-resolvable-personal");
  });
});
