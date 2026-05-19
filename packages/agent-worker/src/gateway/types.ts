/**
 * Worker-side gateway-communication types.
 *
 * `MessagePayload`, `JobType`, and `QueuedMessage` live in `@lobu/core` —
 * see `packages/core/src/worker/wire.ts` — and are re-exported here so the
 * existing `from "./types"` imports inside the worker keep resolving.
 */

import type { ThreadResponsePayload } from "@lobu/core";

export type {
  JobType,
  MessagePayload,
  QueuedMessage,
} from "@lobu/core";

/**
 * Response data sent back to gateway
 */
export type ResponseData = ThreadResponsePayload & {
  originalMessageId: string;
};
