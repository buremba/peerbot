import { deepRedactSecrets, isSecretKey, REDACTED_SENTINEL } from '@lobu/core';
import { type Static, Type } from '@sinclair/typebox';
import type { Env } from '../index';
import { ToolUserError } from '../utils/errors';
import { buildResourcePermalink } from '../utils/url-builder';
import { getContent } from './get_content';
import type { ToolContext } from './registry';
import { withValidatedArgs } from './validate-args';
import { getOrgUrlContext } from './view-urls';

export const LOBU_INTERACTION_RESOURCE_URI = 'ui://lobu/interaction/v1';

const TITLE_MAX_LENGTH = 200;
const BLOCK_MAX_ITEMS = 100;
const TEXT_LABEL_MAX_LENGTH = 120;
const TEXT_VALUE_MAX_LENGTH = 20_000;
const CODE_VALUE_MAX_LENGTH = 40_000;
const DIFF_FIELD_MAX_ITEMS = 100;
const ACTION_MAX_ITEMS = 10;
const ACTION_ID_MAX_LENGTH = 80;
const ACTION_LABEL_MAX_LENGTH = 120;
const ACTION_HREF_MAX_LENGTH = 2_048;
const DISPLAY_REDACTION = '[redacted]';

const TextBlockSchema = Type.Object({
  type: Type.Literal('text'),
  label: Type.Optional(Type.String({ maxLength: TEXT_LABEL_MAX_LENGTH })),
  value: Type.String({ maxLength: TEXT_VALUE_MAX_LENGTH }),
  muted: Type.Optional(Type.Boolean()),
});

const CodeBlockSchema = Type.Object({
  type: Type.Literal('code'),
  value: Type.String({ maxLength: CODE_VALUE_MAX_LENGTH }),
});

const DiffBlockSchema = Type.Object({
  type: Type.Literal('diff'),
  fields: Type.Array(
    Type.Object({
      label: Type.String({ minLength: 1, maxLength: TEXT_LABEL_MAX_LENGTH }),
      before: Type.Optional(Type.String({ maxLength: TEXT_VALUE_MAX_LENGTH })),
      after: Type.String({ maxLength: TEXT_VALUE_MAX_LENGTH }),
    }),
    { maxItems: DIFF_FIELD_MAX_ITEMS }
  ),
});

const LobuViewBlockSchema = Type.Union([TextBlockSchema, CodeBlockSchema, DiffBlockSchema]);

const LinkActionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: ACTION_ID_MAX_LENGTH }),
  label: Type.String({ minLength: 1, maxLength: ACTION_LABEL_MAX_LENGTH }),
  variant: Type.Optional(
    Type.Union([
      Type.Literal('primary'),
      Type.Literal('outline'),
      Type.Literal('ghost'),
      Type.Literal('destructive'),
    ])
  ),
  icon: Type.Optional(Type.Literal('external')),
  terminal: Type.Optional(Type.Boolean()),
  href: Type.String({
    minLength: 1,
    maxLength: ACTION_HREF_MAX_LENGTH,
    pattern: '^https?://',
  }),
});

export const LobuViewSchema = Type.Object({
  version: Type.Literal(1),
  title: Type.Optional(Type.String({ maxLength: TITLE_MAX_LENGTH })),
  tone: Type.Optional(
    Type.Union([Type.Literal('warning'), Type.Literal('default'), Type.Literal('bare')])
  ),
  blocks: Type.Array(LobuViewBlockSchema, { maxItems: BLOCK_MAX_ITEMS }),
  actions: Type.Array(LinkActionSchema, { maxItems: ACTION_MAX_ITEMS }),
});

const RenderActionSchema = Type.Object({
  action: Type.Literal('render', {
    description:
      'Render a compact final card from model-selected data. Call Lobu data tools first; do not use this for ordinary text answers.',
  }),
  title: Type.Optional(Type.String({ maxLength: TITLE_MAX_LENGTH })),
  tone: Type.Optional(
    Type.Union([Type.Literal('warning'), Type.Literal('default'), Type.Literal('bare')])
  ),
  blocks: Type.Array(LobuViewBlockSchema, {
    minItems: 1,
    maxItems: BLOCK_MAX_ITEMS,
  }),
});

const ReviewApprovalActionSchema = Type.Object({
  action: Type.Literal('review_approval', {
    description:
      'Render the server-authored review card for one pending Lobu approval run. The card opens Lobu for the human decision.',
  }),
  run_id: Type.Integer({ minimum: 1 }),
});

export const RenderLobuViewSchema = Type.Union([RenderActionSchema, ReviewApprovalActionSchema]);

type RenderLobuViewArgs = Static<typeof RenderLobuViewSchema>;
type LobuView = Static<typeof LobuViewSchema>;
type LobuViewBlock = Static<typeof LobuViewBlockSchema>;

const DIFF_ROUTING_KEYS = new Set([
  'action',
  'agent_id',
  'base',
  'behavior_id',
  'entity_id',
  'id',
  'owner_user_id',
  'reason',
  'watcher_id',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 1)}…`;
}

function displayRedacted(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replaceAll(REDACTED_SENTINEL, DISPLAY_REDACTION);
  }
  if (Array.isArray(value)) return value.map(displayRedacted);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, displayRedacted(inner)])
  );
}

/**
 * Approval metadata is stored for execution, not presentation. Redact by the
 * field name before detaching a primitive value from its key, then deep-walk
 * nested objects and URI userinfo using the shared Lobu secret classifier.
 */
function redactForDisplay(value: unknown, key?: string): unknown {
  if (key && value != null && isSecretKey(key)) return DISPLAY_REDACTION;
  return displayRedacted(deepRedactSecrets(value));
}

function displayValue(value: unknown, maxLength: number, key?: string): string {
  if (value === undefined || value === null) return '';
  const redacted = redactForDisplay(value, key);
  let rendered: string;
  if (typeof redacted === 'string') {
    rendered = redacted;
  } else {
    try {
      rendered = JSON.stringify(redacted, null, 2);
    } catch {
      rendered = String(redacted);
    }
  }
  return truncate(rendered, maxLength);
}

function approvalBlocks(row: {
  content: string | null;
  interaction_input: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}): LobuViewBlock[] {
  const metadata = row.metadata ?? {};
  const proposal = isRecord(metadata.proposal) ? metadata.proposal : null;
  const current = isRecord(metadata.current) ? metadata.current : null;
  const fields = isRecord(metadata.fields) ? metadata.fields : null;
  const proposed = fields ?? proposal;

  if (proposed) {
    const diffFields = Object.entries(proposed)
      .filter(([key, value]) => !DIFF_ROUTING_KEYS.has(key) && value !== undefined)
      .slice(0, DIFF_FIELD_MAX_ITEMS)
      .map(([key, value]) => ({
        label: truncate(key || 'field', TEXT_LABEL_MAX_LENGTH),
        ...(current && current[key] !== undefined
          ? { before: displayValue(current[key], TEXT_VALUE_MAX_LENGTH, key) }
          : {}),
        after: displayValue(value, TEXT_VALUE_MAX_LENGTH, key),
      }));
    if (diffFields.length > 0) return [{ type: 'diff', fields: diffFields }];
  }

  if (row.interaction_input && Object.keys(row.interaction_input).length > 0) {
    return [
      {
        type: 'code',
        value: displayValue(row.interaction_input, CODE_VALUE_MAX_LENGTH),
      },
    ];
  }

  return [
    {
      type: 'text',
      value: displayValue(row.content || 'Review this pending Lobu action.', TEXT_VALUE_MAX_LENGTH),
      muted: true,
    },
  ];
}

function sanitizeBlocks(blocks: LobuViewBlock[]): LobuViewBlock[] {
  return blocks.slice(0, BLOCK_MAX_ITEMS).map((block) => {
    if (block.type === 'text') {
      return {
        ...block,
        ...(block.label ? { label: truncate(block.label, TEXT_LABEL_MAX_LENGTH) } : {}),
        value: displayValue(block.value, TEXT_VALUE_MAX_LENGTH, block.label),
      };
    }
    if (block.type === 'code') {
      return {
        type: 'code',
        value: displayValue(block.value, CODE_VALUE_MAX_LENGTH),
      };
    }
    return {
      type: 'diff',
      fields: block.fields.slice(0, DIFF_FIELD_MAX_ITEMS).map((field) => ({
        label: truncate(field.label, TEXT_LABEL_MAX_LENGTH),
        ...(field.before !== undefined
          ? {
              before: displayValue(field.before, TEXT_VALUE_MAX_LENGTH, field.label),
            }
          : {}),
        after: displayValue(field.after, TEXT_VALUE_MAX_LENGTH, field.label),
      })),
    };
  });
}

type ApprovalContentItem = {
  run_id: number;
  title: string | null;
  payload_text: string;
  interaction_type: 'approval';
  interaction_status: string | null;
  interaction_input: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

function isApprovalContentItem(value: unknown, runId: number): value is ApprovalContentItem {
  if (!isRecord(value)) return false;
  return value.run_id === runId && value.interaction_type === 'approval';
}

async function buildApprovalView(runId: number, env: Env, ctx: ToolContext): Promise<LobuView> {
  // Reuse the canonical knowledge read so connection visibility, public-org
  // rules, caller identity, and MCP scope checks cannot drift from the event
  // surface. A direct current_event_records query here would be tenant-fenced
  // but could bypass a private connection's ACL.
  const result = await getContent(
    { run_ids: [runId], limit: 50, sort_by: 'date', sort_order: 'desc' },
    env,
    ctx
  );
  const row = result.content.find((item) => isApprovalContentItem(item, runId));
  if (!row) throw new ToolUserError(`Approval run ${runId} was not found`, 404);

  const status = row.interaction_status ?? 'pending';
  const baseTitle = displayValue(row.title ?? `Approval run ${runId}`, TITLE_MAX_LENGTH).replace(
    /\s+—\s+pending approval$/i,
    ''
  );
  const actions: LobuView['actions'] = [];
  if (status === 'pending') {
    const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
    const href = buildResourcePermalink(ownerSlug, { kind: 'run', runId }, baseUrl);
    if (!href || href.length > ACTION_HREF_MAX_LENGTH || !/^https?:\/\//i.test(href)) {
      throw new ToolUserError('The Lobu review link is unavailable for this workspace.', 500);
    }
    actions.push({
      id: 'review',
      label: 'Review in Lobu',
      variant: 'primary',
      icon: 'external',
      terminal: false,
      href,
    });
  }

  return {
    version: 1,
    title: truncate(
      status === 'pending' ? baseTitle : `${baseTitle} · ${status}`,
      TITLE_MAX_LENGTH
    ),
    tone: status === 'pending' ? 'warning' : 'default',
    blocks: approvalBlocks({
      content: row.payload_text,
      interaction_input: row.interaction_input,
      metadata: row.metadata,
    }),
    actions,
  };
}

const renderLobuViewImpl = async (
  args: RenderLobuViewArgs,
  env: Env,
  ctx: ToolContext
): Promise<LobuView> => {
  if (args.action === 'review_approval') return buildApprovalView(args.run_id, env, ctx);
  return {
    version: 1,
    ...(args.title ? { title: displayValue(args.title, TITLE_MAX_LENGTH) } : {}),
    ...(args.tone ? { tone: args.tone } : {}),
    blocks: sanitizeBlocks(args.blocks),
    actions: [],
  };
};

export const renderLobuView = withValidatedArgs(
  'render_lobu_view',
  RenderLobuViewSchema,
  renderLobuViewImpl
);
