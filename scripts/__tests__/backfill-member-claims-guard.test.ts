/**
 * Retarget hazard for --include-shared:
 * resolveTenantMember prefers a personal_org_for_user_id tag, then falls back
 * to createdAt ASC among private orgs with claims. Backfilling a claim into an
 * older private shared org for a user with no tagged personal org would make
 * that shared org win the fallback and redirect personal identity facts into it.
 */

import { describe, expect, it } from "bun:test";
import { decideSharedPrivateBackfill } from "../backfill-member-claims";

describe("decideSharedPrivateBackfill", () => {
  it("skips shared private orgs by default (no --include-shared)", () => {
    expect(
      decideSharedPrivateBackfill({
        includeShared: false,
        hasTaggedPersonalOrg: true,
      })
    ).toBe("skip-shared-default");
    expect(
      decideSharedPrivateBackfill({
        includeShared: false,
        hasTaggedPersonalOrg: false,
      })
    ).toBe("skip-shared-default");
  });

  it("allows --include-shared only when the user has a tagged personal org", () => {
    expect(
      decideSharedPrivateBackfill({
        includeShared: true,
        hasTaggedPersonalOrg: true,
      })
    ).toBe("backfill");
  });

  it("refuses --include-shared when the user has no tagged personal org", () => {
    // Legacy user: untagged personal org + older private shared org.
    // Without this skip, resolveTenantMember falls back to createdAt and can
    // redirect personal identity facts into the shared org.
    expect(
      decideSharedPrivateBackfill({
        includeShared: true,
        hasTaggedPersonalOrg: false,
      })
    ).toBe("skip-no-tagged-personal");
  });
});
