/**
 * Derived feed-health semantics — pure classification tests.
 *
 * Guards the executionMode / attention / incidentEligible derivation. No DB —
 * the module is a pure function over the joined row fields, so every state is
 * testable with plain objects.
 */

import { describe, expect, test } from "bun:test";
import { deriveFeedHealthSemantics } from "../feed-health-semantics";

describe("executionMode", () => {
  test("virtual feed (kind='virtual' or virtual=true) is virtual", () => {
    expect(
      deriveFeedHealthSemantics({ kind: "virtual", status: "active" })
        .executionMode
    ).toBe("virtual");
    expect(
      deriveFeedHealthSemantics({ virtual: true, status: "active" })
        .executionMode
    ).toBe("virtual");
  });

  test("non-virtual feed with a schedule is scheduled", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
      }).executionMode
    ).toBe("scheduled");
  });

  test("non-virtual feed without a schedule is manual", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: null,
        status: "active",
      }).executionMode
    ).toBe("manual");
  });

  test("empty-string schedule is manual (treated as absent)", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "",
        status: "active",
      }).executionMode
    ).toBe("manual");
  });
});

describe("attention state", () => {
  test("healthy active feed with a successful sync", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "active",
        last_sync_status: "success",
        last_sync_at: new Date(),
        consecutive_failures: 0,
      }).attention
    ).toBe("healthy");
  });

  test("paused feed is paused, even with prior failures", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "paused",
        connection_status: "active",
        last_sync_status: "failed",
        consecutive_failures: 21,
      }).attention
    ).toBe("paused");
  });

  test("paused connection is paused", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "paused",
      }).attention
    ).toBe("paused");
  });

  test("pending_auth connection is needs_auth", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "pending_auth",
      }).attention
    ).toBe("needs_auth");
  });

  test("non-active auth profile is needs_auth", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "active",
        auth_profile_status: "revoked",
      }).attention
    ).toBe("needs_auth");
  });

  test("active auth profile is not needs_auth", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "active",
        auth_profile_status: "active",
      }).attention
    ).toBe("never_run");
  });

  test("device-pinned feed with offline device is device_offline", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "active",
        device_worker_id: "dw-1",
        device_online: false,
      }).attention
    ).toBe("device_offline");
  });

  test("device-pinned feed with online device is not device_offline", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "active",
        device_worker_id: "dw-1",
        device_online: true,
      }).attention
    ).toBe("never_run");
  });

  test("last failed sync is last_attempt_failed", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "active",
        last_sync_status: "failed",
        consecutive_failures: 3,
      }).attention
    ).toBe("last_attempt_failed");
  });

  test("consecutive failures without a last failure is last_attempt_failed", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "active",
        last_sync_status: "pending",
        consecutive_failures: 1,
      }).attention
    ).toBe("last_attempt_failed");
  });

  test("never synced is never_run", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "active",
        last_sync_at: null,
      }).attention
    ).toBe("never_run");
  });

  test("misconfigured when expectSchedule and feed is manual", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: null,
        status: "active",
        connection_status: "active",
        expectSchedule: true,
      }).attention
    ).toBe("misconfigured");
  });

  test("not misconfigured without expectSchedule opt-in", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: null,
        status: "active",
        connection_status: "active",
      }).attention
    ).toBe("never_run");
  });

  test("error connection status is misconfigured when not auth", () => {
    // 'error' connection status is treated as needs_auth by the auth rule;
    // the error branch covers a plain error status not otherwise classified.
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "error",
        connection_status: "active",
      }).attention
    ).toBe("misconfigured");
  });

  test("virtual feed is always healthy (evaluated on demand)", () => {
    expect(
      deriveFeedHealthSemantics({ kind: "virtual", status: "active" }).attention
    ).toBe("healthy");
    expect(
      deriveFeedHealthSemantics({ kind: "virtual", status: "paused" }).attention
    ).toBe("healthy");
  });
});

describe("incidentEligible", () => {
  test("false for virtual feeds", () => {
    expect(
      deriveFeedHealthSemantics({ kind: "virtual", status: "active" })
        .incidentEligible
    ).toBe(false);
  });

  test("false for manual feeds even when the last attempt failed (Midas)", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: null,
        status: "active",
        connection_status: "active",
        last_sync_status: "failed",
        consecutive_failures: 5,
      }).incidentEligible
    ).toBe(false);
  });

  test("false for paused feeds", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "paused",
        connection_status: "active",
        last_sync_status: "failed",
        consecutive_failures: 21,
      }).incidentEligible
    ).toBe(false);
  });

  test("false for scheduled feed awaiting auth", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "pending_auth",
        last_sync_status: "failed",
        consecutive_failures: 2,
      }).incidentEligible
    ).toBe(false);
  });

  test("true for a failing active scheduled feed on an active connection", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "active",
        last_sync_status: "failed",
        consecutive_failures: 2,
      }).incidentEligible
    ).toBe(true);
  });

  test("true when a scheduled feed's pinned device is offline", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "active",
        device_worker_id: "dw-1",
        device_online: false,
      }).incidentEligible
    ).toBe(true);
  });

  test("false for a healthy scheduled feed", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "active",
        last_sync_status: "success",
        consecutive_failures: 0,
      }).incidentEligible
    ).toBe(false);
  });

  test("false for a never-run scheduled feed", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "active",
        last_sync_at: null,
      }).incidentEligible
    ).toBe(false);
  });

  test("false when the connection is not active", () => {
    expect(
      deriveFeedHealthSemantics({
        kind: "collected",
        schedule: "0 */6 * * *",
        status: "active",
        connection_status: "error",
        last_sync_status: "failed",
        consecutive_failures: 2,
      }).incidentEligible
    ).toBe(false);
  });
});
