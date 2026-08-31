import { Type } from "@sinclair/typebox";

export const MAX_TOOL_PAGE_SIZE = 500;
export const MAX_TOOL_PAGE_OFFSET = 1_000_000;

/** Shared offset-pagination contract for agent-facing list methods. */
export function paginationFields(defaultLimit: number) {
  return {
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_TOOL_PAGE_SIZE,
        default: defaultLimit,
        description: `Page size (default: ${defaultLimit}, max: ${MAX_TOOL_PAGE_SIZE})`,
      })
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: MAX_TOOL_PAGE_OFFSET,
        default: 0,
        description: `Pagination offset (default: 0, max: ${MAX_TOOL_PAGE_OFFSET})`,
      })
    ),
  };
}
