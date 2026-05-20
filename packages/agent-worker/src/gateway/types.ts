/**
 * Worker-side response payload returned to the gateway over HTTP.
 *
 * The gateway↔worker wire contract (`MessagePayload`, `JobType`,
 * `QueuedMessage`) is exported from `@lobu/core` — import from there
 * directly, not from this file.
 */

import type { ThreadResponsePayload } from "@lobu/core";

export type ResponseData = ThreadResponsePayload & {
  originalMessageId: string;
};
