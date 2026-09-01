/**
 * `headless` is the default platform of `lobu daemon`, and `startDaemonCommand`
 * calls `assertExternalDepsResolvable()` / `assertConnectorRuntimeLoadable()`
 * before its first poll — so a headless daemon that is polling at all has
 * already proven it can execute compiled connectors.
 *
 * An earlier draft advertised `compiled_connector: 0` for headless on the
 * theory that a recovery daemon keeps its compiler runtime closed. It does not,
 * and the claim lane gates compiled artifacts on exactly this number: every
 * execution-pinned compiled connection on a self-hosted device worker would
 * have stopped being claimed, queued forever with no error raised anywhere.
 */

import { describe, expect, test } from "bun:test";
import {
  EXECUTION_BACKENDS,
  defaultBackendCapacity,
} from "../contracts/worker/protocol.js";

describe("defaultBackendCapacity", () => {
  test("keeps the compiled lane open on every platform", () => {
    for (const platform of [
      "headless",
      "macos",
      "chrome-extension",
      "ios",
      null,
      undefined,
    ]) {
      expect(
        defaultBackendCapacity(platform)[EXECUTION_BACKENDS.compiledConnector]
      ).toBeGreaterThan(0);
    }
  });

  test("grants the daemon builtin only to the platform that runs a daemon", () => {
    expect(
      defaultBackendCapacity("headless")[EXECUTION_BACKENDS.daemonBuiltin]
    ).toBeGreaterThan(0);
    // The Chrome extension and the macOS app poll the gateway directly rather
    // than running `lobu daemon`, so they own no in-process builtin.
    for (const platform of ["macos", "chrome-extension", null]) {
      expect(
        defaultBackendCapacity(platform)[EXECUTION_BACKENDS.daemonBuiltin]
      ).toBeUndefined();
    }
  });
});
