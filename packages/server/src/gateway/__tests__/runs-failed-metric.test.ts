import { describe, expect, test } from "bun:test";
import {
  getMetricsText,
  incrementCounter,
} from "../metrics/prometheus.js";

describe("lobu_runs_failed_total metric", () => {
  test("is registered as a counter and renders with run_type + queue labels", () => {
    const text0 = getMetricsText();
    expect(text0).toContain("# TYPE lobu_runs_failed_total counter");

    incrementCounter("lobu_runs_failed_total", {
      run_type: "chat_message",
      queue: "thread_response",
    });

    const text = getMetricsText();
    const line = text
      .split("\n")
      .find(
        (l) =>
          l.startsWith("lobu_runs_failed_total{") &&
          l.includes('run_type="chat_message"') &&
          l.includes('queue="thread_response"')
      );
    expect(line).toBeDefined();
    // Value is the trailing number on the sample line.
    expect(Number(line?.trim().split(/\s+/).pop())).toBeGreaterThanOrEqual(1);
  });
});
