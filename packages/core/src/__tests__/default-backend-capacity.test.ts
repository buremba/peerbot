/**
 * `startDaemonCommand` calls `assertExternalDepsResolvable()` /
 * `assertConnectorRuntimeLoadable()` before its first poll — so a daemon that
 * is polling at all has already proven it can execute compiled connectors.
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
  test("keeps the compiled lane open", () => {
    expect(
      defaultBackendCapacity()[EXECUTION_BACKENDS.compiledConnector]
    ).toBeGreaterThan(0);
  });

  // Capacity describes what the SERVER may hand over as code. A connector the
  // endpoint implements itself is routed from that endpoint's own registry and
  // needs no advertised backend, so there is nothing platform-specific left to
  // advertise and no second key to grant.
  test("advertises the compiled lane and nothing else", () => {
    expect(Object.keys(defaultBackendCapacity())).toEqual([
      EXECUTION_BACKENDS.compiledConnector,
    ]);
  });
});
