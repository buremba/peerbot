/**
 * Read-time run error classification — pure-function tests.
 *
 * No DB: the classifier maps stored run fields to a category + retryable +
 * operationalIncident verdict. Covers every category, the incident gating on
 * execution mode, and the known prod error-string corpus.
 */

import { describe, expect, test } from "bun:test";
import { classifyRunError } from "../error-classification";

describe("classifyRunError — status-driven verdicts", () => {
  test("cancelled is never an incident and never retried", () => {
    expect(classifyRunError({ status: "cancelled", errorMessage: "rejected by user" })).toEqual({
      category: "cancelled",
      retryable: false,
      operationalIncident: false,
    });
  });

  test("timeout is an infra incident; never-claimed timeouts are retryable", () => {
    expect(
      classifyRunError({ status: "timeout", errorMessage: "was never claimed within 60s" }),
    ).toEqual({
      category: "timeout",
      retryable: true,
      operationalIncident: true,
    });
    expect(
      classifyRunError({ status: "timeout", errorMessage: "heartbeat lost" }),
    ).toEqual({
      category: "timeout",
      retryable: false,
      operationalIncident: true,
    });
  });

  test("completed is not an incident", () => {
    expect(classifyRunError({ status: "completed", errorMessage: null })).toEqual({
      category: "internal",
      retryable: false,
      operationalIncident: false,
    });
  });
});

describe("classifyRunError — message classification", () => {
  test("auth wall / expired session → auth_required, never retried, never an incident", () => {
    const cases = [
      "Sign in to continue",
      "Not logged into LinkedIn (landed on https://www.linkedin.com/login)",
      "session expired, please re-authenticate",
      "Midas session needs sign-in",
      "AUTH_MISSING",
      "The connection is pending_auth",
    ];
    for (const message of cases) {
      expect(classifyRunError({ status: "failed", errorMessage: message }).category).toBe(
        "auth_required",
      );
      expect(
        classifyRunError({ status: "failed", errorMessage: message }).operationalIncident,
      ).toBe(false);
    }
  });

  test("permission denied → permission_required", () => {
    expect(
      classifyRunError({ status: "failed", errorMessage: "permission denied: scope missing" })
        .category,
    ).toBe("permission_required");
  });

  test("target gone → target_gone (not found / deleted post / 404)", () => {
    const cases = [
      "Post not found",
      "The post you are looking for does not exist",
      "target_gone",
      "404 Not Found",
    ];
    for (const message of cases) {
      expect(classifyRunError({ status: "failed", errorMessage: message }).category).toBe(
        "target_gone",
      );
    }
  });

  test("invalid input → invalid_input", () => {
    expect(
      classifyRunError({
        status: "failed",
        errorMessage: "validation failed: body must be non-empty",
      }).category,
    ).toBe("invalid_input");
  });

  test("provider quota exhausted stops immediately (not retryable)", () => {
    const res = classifyRunError({
      status: "failed",
      errorMessage: "Insufficient credits. Please add funds to continue.",
    });
    expect(res.category).toBe("provider_quota");
    expect(res.retryable).toBe(false);
  });

  test("transient 429 throttle is retryable provider_quota", () => {
    const res = classifyRunError({
      status: "failed",
      errorMessage: "429 Too Many Requests — retry after 30s",
    });
    expect(res.category).toBe("provider_quota");
    expect(res.retryable).toBe(true);
  });

  test("provider quota on a scheduled feed is an operational incident", () => {
    const res = classifyRunError({
      status: "failed",
      errorMessage: "provider quota exceeded",
      executionMode: "scheduled",
    });
    expect(res.operationalIncident).toBe(true);
  });

  test("provider quota on a manual run is NOT an incident (user-initiated)", () => {
    const res = classifyRunError({
      status: "failed",
      errorMessage: "provider quota exceeded",
      executionMode: "manual",
    });
    expect(res.operationalIncident).toBe(false);
  });

  test("device offline → device_unavailable, retryable, incident only when scheduled", () => {
    const off = classifyRunError({
      status: "failed",
      errorMessage: "No online paired Owletto Chrome extension in this organization",
      executionMode: "scheduled",
    });
    expect(off.category).toBe("device_unavailable");
    expect(off.retryable).toBe(true);
    expect(off.operationalIncident).toBe(true);

    const manual = classifyRunError({
      status: "failed",
      errorMessage: "No online paired Owletto Chrome extension",
      executionMode: "manual",
    });
    expect(manual.operationalIncident).toBe(false);
  });

  test("transient external failure → transient_external", () => {
    const res = classifyRunError({
      status: "failed",
      errorMessage: "upstream connect error or disconnect/reset before headers",
    });
    expect(res.category).toBe("transient_external");
    expect(res.retryable).toBe(true);
  });

  test("worker crashed → internal, infra incident", () => {
    const res = classifyRunError({
      status: "failed",
      errorMessage: "worker died mid-turn",
    });
    expect(res.category).toBe("internal");
    expect(res.operationalIncident).toBe(true);
  });

  test("unknown failure fails toward visibility (internal)", () => {
    const res = classifyRunError({
      status: "failed",
      errorMessage: "Some novel error we have never seen before",
    });
    expect(res.category).toBe("internal");
    expect(res.operationalIncident).toBe(true);
  });

  test("empty message with failed status → internal", () => {
    const res = classifyRunError({ status: "failed", errorMessage: null });
    expect(res.category).toBe("internal");
    expect(res.retryable).toBe(true);
  });
});

describe("classifyRunError — auth signal sharpening", () => {
  test("auth_signal presence + auth wording → auth_required even without status", () => {
    const res = classifyRunError({
      status: "failed",
      errorMessage: "session invalid",
      authSignal: { name: "auth.expired" },
    });
    expect(res.category).toBe("auth_required");
    expect(res.operationalIncident).toBe(false);
  });
});

describe("classifyRunError — not_actionable / non-failing inputs are not incidents", () => {
  test("a message about a non-actionable input does not surface as an incident", () => {
    // prepare_comment returns not_actionable with reason 'missing_durable_post_id' —
    // a non-failing result that must never count against infrastructure uptime.
    const res = classifyRunError({
      status: "failed",
      errorMessage: "not_actionable: missing_durable_post_id",
    });
    expect(res.category).toBe("invalid_input");
    expect(res.retryable).toBe(false);
    expect(res.operationalIncident).toBe(false);
  });

  test("a completed not_actionable run is not an incident", () => {
    // The real non-failing path: prepare_comment returns success with
    // status:not_actionable in its output, so the run completes.
    const res = classifyRunError({
      status: "completed",
      errorMessage: null,
    });
    expect(res.operationalIncident).toBe(false);
  });
});
