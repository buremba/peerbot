import { describe, expect, it } from "vitest";
import {
  type ManageWatchersArgs,
  normalizeWatcherUpdatePatch,
} from "../contracts/tools/manage-watchers";

/**
 * The normalizer is the SINGLE SOURCE OF TRUTH for a manage_watchers UPDATE's
 * stored write-normalization — the apply handler (handleUpdate SET clause) and
 * the config-approval review's `proposedAfter` both call it, so these coercions
 * are what "displayed == applied" rests on. Mirrors the SET-clause coercions in
 * server tools/admin/manage_watchers/crud.ts handleUpdate.
 */
const update = (extra: Partial<ManageWatchersArgs>): ManageWatchersArgs =>
  ({ action: "update", watcher_id: "1", ...extra }) as ManageWatchersArgs;

describe("normalizeWatcherUpdatePatch", () => {
  it("only emits keys PRESENT in args (a PATCH — absent keys keep current)", () => {
    expect(normalizeWatcherUpdatePatch(update({ timezone: "UTC" }))).toEqual({
      timezone: "UTC",
    });
  });

  it("schedule falsy ('') stores as null (handler: args.schedule || null)", () => {
    expect(
      normalizeWatcherUpdatePatch(update({ schedule: "" })).schedule
    ).toBeNull();
  });

  it("model_config null stores as {} (handler: args.model_config ?? {})", () => {
    expect(
      normalizeWatcherUpdatePatch(update({ model_config: null as never }))
        .model_config
    ).toEqual({});
  });

  it("tags falsy stores as [] (handler: args.tags || [])", () => {
    expect(
      normalizeWatcherUpdatePatch(update({ tags: null as never })).tags
    ).toEqual([]);
  });

  it("tags are trimmed, empties dropped, duplicates removed (matches toTextArrayParam)", () => {
    // The stored SQL array goes through the same normalizeWatcherTags, so the
    // review must show the SAME cleaned array — not the raw input.
    expect(
      normalizeWatcherUpdatePatch(
        update({ tags: ["  a  ", "a", "", "b", " b "] as never })
      ).tags
    ).toEqual(["a", "b"]);
  });

  it("execution_config null is PRESERVED (a real clear the write applies)", () => {
    // ?? undefined would serialize the key away and hide the clear from the
    // review; the write stores SQL null, so proposedAfter must keep null.
    const p = normalizeWatcherUpdatePatch(
      update({ execution_config: null as never })
    );
    expect("execution_config" in p).toBe(true);
    expect(p.execution_config).toBeNull();
  });

  it("notification defaults: channel→'canvas', priority→'normal', cooldown→0", () => {
    const p = normalizeWatcherUpdatePatch(
      update({
        notification_channel: null as never,
        notification_priority: null as never,
        min_cooldown_seconds: null as never,
      })
    );
    expect(p.notification_channel).toBe("canvas");
    expect(p.notification_priority).toBe("normal");
    expect(p.min_cooldown_seconds).toBe(0);
  });

  it("non-empty values pass through unchanged", () => {
    const p = normalizeWatcherUpdatePatch(
      update({
        schedule: "0 9 * * *",
        timezone: "Asia/Taipei",
        tags: ["a"],
        notification_channel: "both",
      })
    );
    expect(p).toMatchObject({
      schedule: "0 9 * * *",
      timezone: "Asia/Taipei",
      tags: ["a"],
      notification_channel: "both",
    });
  });

  it("excludes version-owned + routing fields (name/prompt/watcher_id/etc.)", () => {
    const p = normalizeWatcherUpdatePatch(
      update({ name: "X", prompt: "Y", schedule: "0 9 * * *" } as never)
    );
    expect("name" in p).toBe(false);
    expect("prompt" in p).toBe(false);
    expect("watcher_id" in p).toBe(false);
    expect("action" in p).toBe(false);
    expect(p.schedule).toBe("0 9 * * *"); // the one applied field
  });
});
