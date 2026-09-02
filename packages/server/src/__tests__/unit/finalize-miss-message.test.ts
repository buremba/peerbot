/**
 * What a finalize miss tells the human reading `runs.error_message`.
 *
 * `describeFinalizeMiss` swallows a failed approval read on purpose — the
 * sweep that calls it must not die because `oauth_states` hiccuped. The risk
 * that creates is a confident wrong answer: "No active tool approval was
 * found" is a claim about what the read returned, and after a failed read
 * there is no such claim to make. Whoever reads it would go check the agent's
 * MCP wiring instead of the transient fault that actually happened.
 */

import { describe, expect, test } from "bun:test";
import type { DbClient } from "../../db/client";
import { describeFinalizeMiss } from "../../automations/run-completion";

/** A client whose every query rejects, standing in for a database hiccup. */
const failingDb = (() =>
  Promise.reject(new Error("oauth_states unavailable"))) as unknown as DbClient;

/** A client that answers every diagnostic query with no rows. */
const emptyDb = (() => {
  const rows: unknown[] = [];
  return Promise.resolve(Object.assign(rows, { count: 0 }));
}) as unknown as DbClient;

describe("describeFinalizeMiss", () => {
  test("does not claim no approval was found when the read failed", async () => {
    const message = await describeFinalizeMiss(failingDb, 456, 2);
    expect(message).toMatch(/finished without calling run_sdk/);
    expect(message).toMatch(/could not be checked/);
    // The false claim, and the wiring advice that follows from it.
    expect(message).not.toMatch(/No active tool approval was found/);
    expect(message).not.toMatch(/lobu-memory MCP attached/);
  });

  test("still reports a clean empty read as no approval found", async () => {
    const message = await describeFinalizeMiss(emptyDb, 456, 2);
    expect(message).toMatch(/No active tool approval was found/);
    expect(message).not.toMatch(/could not be checked/);
  });

  test("counts attempts from the nudge budget", async () => {
    expect(await describeFinalizeMiss(emptyDb, 456, 2)).toMatch(
      /after 3 attempt\(s\)/,
    );
    expect(await describeFinalizeMiss(emptyDb, 456, 0)).not.toMatch(
      /attempt\(s\)/,
    );
  });
});
