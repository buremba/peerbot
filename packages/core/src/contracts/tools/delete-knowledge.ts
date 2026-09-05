/**
 * Tool contract: `delete_knowledge`.
 *
 * Lives in core because it crosses package boundaries: the server validates
 * against it, and `@lobu/connector-sdk` derives the `client.knowledge.delete`
 * input it publishes to reaction authors. Both derive from this one
 * declaration so neither can drift from the schema the handler enforces.
 *
 * Typebox only — no `node:` imports and nothing from core's root index, so the
 * connector isolate lane can bundle it (`packages/connector-sdk/AGENTS.md`).
 */

import { type Static, Type } from "@sinclair/typebox";

export const DeleteContentSchema = Type.Object({
  content_id: Type.Optional(
    Type.Number({
      description:
        "Single content id to delete. Provide either this or `content_ids`.",
    })
  ),
  content_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "Batch of content ids to delete. Provide either this or `content_id`.",
    })
  ),
  reason: Type.Optional(
    Type.String({
      description:
        "Optional human-readable reason; persisted on the tombstone for audit trails.",
    })
  ),
});

export type DeleteContentArgs = Static<typeof DeleteContentSchema>;
