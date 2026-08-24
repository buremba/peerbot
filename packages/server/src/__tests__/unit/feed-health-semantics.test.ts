import { describe, expect, test } from "bun:test";
import { deriveFeedHealthSemantics } from "../../connectors/feed-health-semantics";

const syncFeed = (
  input: Parameters<typeof deriveFeedHealthSemantics>[0],
  now?: number,
) => deriveFeedHealthSemantics({ operations: ["sync"], store: "events", ...input }, now);

describe("feed execution mode", () => {
  test("a read-only feed is source_only", () => {
    expect(
      deriveFeedHealthSemantics({ operations: ["read"], store: "events", status: "active" }),
    ).toEqual({ executionMode: "source_only", attention: "healthy" });
  });

  test("a hybrid feed uses its sync schedule", () => {
    expect(
      deriveFeedHealthSemantics({
        operations: ["sync", "read"],
        store: "events",
        schedule: "0 */6 * * *",
        status: "active",
      }).executionMode,
    ).toBe("scheduled");
  });

  test("a sync feed without a schedule is no_schedule", () => {
    expect(syncFeed({ schedule: null, status: "active" }).executionMode).toBe("no_schedule");
    expect(syncFeed({ schedule: "", status: "active" }).executionMode).toBe("no_schedule");
  });

  test("channel storage is streaming regardless of connector operations", () => {
    expect(
      deriveFeedHealthSemantics({
        operations: ["read"],
        store: "channel_messages",
        status: "active",
      }),
    ).toEqual({ executionMode: "streaming", attention: "healthy" });
  });
});

describe("feed attention", () => {
  test("lifecycle, auth, configuration, and device failures have precedence", () => {
    expect(syncFeed({ status: "paused", last_sync_status: "failed" }).attention).toBe("paused");
    expect(syncFeed({ status: "active", connection_status: "paused" }).attention).toBe("paused");
    expect(syncFeed({ status: "active", connection_status: "pending_auth" }).attention).toBe(
      "needs_auth",
    );
    expect(syncFeed({ status: "active", auth_profile_status: "revoked" }).attention).toBe(
      "needs_auth",
    );
    expect(syncFeed({ status: "active", connection_status: "error" }).attention).toBe(
      "misconfigured",
    );
    expect(
      syncFeed({ status: "active", device_worker_id: "dw-1", device_online: false }).attention,
    ).toBe("device_offline");
  });

  test("sync failure, never-run, and success states remain distinct", () => {
    expect(syncFeed({ status: "active", last_sync_status: "failed" }).attention).toBe(
      "last_attempt_failed",
    );
    expect(syncFeed({ status: "active", consecutive_failures: 1 }).attention).toBe(
      "last_attempt_failed",
    );
    expect(syncFeed({ status: "active", last_sync_at: null }).attention).toBe("never_run");
    expect(
      syncFeed({ status: "active", last_sync_status: "success", last_sync_at: null }).attention,
    ).toBe("healthy");
  });

  test("a scheduled feed becomes overdue only after the one-hour margin", () => {
    const now = Date.parse("2026-08-21T12:00:00Z");
    expect(
      syncFeed(
        {
          schedule: "0 * * * *",
          status: "active",
          last_sync_status: "success",
          next_run_at: "2026-08-21T10:00:00Z",
          active_runs: 0,
        },
        now,
      ).attention,
    ).toBe("overdue");
    expect(
      syncFeed(
        {
          schedule: null,
          status: "active",
          last_sync_status: "success",
          last_sync_at: "2026-01-01T00:00:00Z",
        },
        now,
      ).attention,
    ).toBe("healthy");
  });

  test("source-only and channel-message feeds ignore sync history but keep operational attention", () => {
    expect(
      deriveFeedHealthSemantics({
        operations: ["read"],
        store: "events",
        status: "active",
        last_sync_status: "failed",
      }).attention,
    ).toBe("healthy");
    expect(
      deriveFeedHealthSemantics({
        operations: [],
        store: "channel_messages",
        status: "active",
        connection_status: "pending_auth",
      }).attention,
    ).toBe("needs_auth");
  });
});
