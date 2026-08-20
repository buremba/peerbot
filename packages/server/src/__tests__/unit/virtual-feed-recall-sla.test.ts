/**
 * The ambient-recall SLA spans two repositories, so it is asserted across both.
 *
 * `search_memory` gives ONE virtual feed `VIRTUAL_FEED_RECALL_BUDGET_MS`. A
 * `whatsapp.local` live read is served by the paired Mac over the device action
 * queue, so the budget is only met if the Mac is POLLING fast enough to claim
 * the run inside it. That interval lives in the Owletto submodule
 * (`LobuDeviceConnectivityPolicy.actionPollInterval`), where no server test
 * would otherwise look.
 *
 * This is not a style check. At Owletto's previous 10s action cadence the
 * worst-case claim path was ~11.4s against a 5s budget — every ambient WhatsApp
 * recall timed out, always. Raising the poll interval again, or lowering the
 * budget, must fail HERE rather than silently in production.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { VIRTUAL_FEED_RECALL_BUDGET_MS } from '../../config/intervals';

const POLICY_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../owletto/apps/mac/Owletto/LobuContextIdentity.swift'
);

/**
 * Measured on a real 47MB WhatsApp Desktop archive. The budget has to cover the
 * device's own work, not just the wait for it.
 */
const MEASURED_ARCHIVE_QUERY_MS = 900;
/**
 * `waitForDeviceActionRun` polls the runs table every 500ms, so a completion is
 * observed up to one interval after the device posts it.
 */
const GATEWAY_WAITER_GRANULARITY_MS = 500;

function readActionPollIntervalMs(): number | null {
  if (!existsSync(POLICY_PATH)) return null;
  const source = readFileSync(POLICY_PATH, 'utf8');
  const match = source.match(
    /static\s+let\s+actionPollInterval:\s*TimeInterval\s*=\s*([0-9]+(?:\.[0-9]+)?)/
  );
  return match ? Number(match[1]) * 1000 : null;
}

describe('ambient virtual-feed recall SLA', () => {
  const actionPollMs = readActionPollIntervalMs();
  // The submodule is not checked out in every environment. Skipping is honest;
  // silently passing on a regex that matched nothing would not be.
  const maybe = actionPollMs === null ? it.skip : it;

  it('finds the Owletto poll policy to check against', () => {
    if (!existsSync(POLICY_PATH)) return; // submodule absent — nothing to assert
    expect(actionPollMs).not.toBeNull();
  });

  maybe('claim + query + waiter granularity fits inside the recall budget', () => {
    const worstCase =
      (actionPollMs as number) + MEASURED_ARCHIVE_QUERY_MS + GATEWAY_WAITER_GRANULARITY_MS;
    expect(worstCase).toBeLessThan(VIRTUAL_FEED_RECALL_BUDGET_MS);
  });

  maybe('leaves usable network margin rather than only just fitting', () => {
    const worstCase =
      (actionPollMs as number) + MEASURED_ARCHIVE_QUERY_MS + GATEWAY_WAITER_GRANULARITY_MS;
    // A budget met with 50ms to spare is met only on a quiet network.
    expect(VIRTUAL_FEED_RECALL_BUDGET_MS - worstCase).toBeGreaterThanOrEqual(1_000);
  });
});
