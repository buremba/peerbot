import { Type, type Static } from '@sinclair/typebox';
import type { Env } from '../index';
import { ToolUserError } from '../utils/errors';
import { buildResourcePermalink } from '../utils/url-builder';
import { getContent } from './get_content';
import type { ToolContext } from './registry';
import { withValidatedArgs } from './validate-args';
import { getOrgUrlContext } from './view-urls';

export const LOBU_INTERACTION_RESOURCE_URI = 'ui://lobu/interaction/v1';

const TextBlockSchema = Type.Object({
  type: Type.Literal('text'),
  label: Type.Optional(Type.String({ maxLength: 120 })),
  value: Type.String({ maxLength: 20_000 }),
  muted: Type.Optional(Type.Boolean()),
});

const CodeBlockSchema = Type.Object({
  type: Type.Literal('code'),
  value: Type.String({ maxLength: 40_000 }),
});

const DiffBlockSchema = Type.Object({
  type: Type.Literal('diff'),
  fields: Type.Array(
    Type.Object({
      label: Type.String({ minLength: 1, maxLength: 120 }),
      before: Type.Optional(Type.String({ maxLength: 20_000 })),
      after: Type.String({ maxLength: 20_000 }),
    }),
    { maxItems: 100 }
  ),
});

export const LobuViewBlockSchema = Type.Union([
  TextBlockSchema,
  CodeBlockSchema,
  DiffBlockSchema,
]);

const LinkActionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }),
  label: Type.String({ minLength: 1, maxLength: 120 }),
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
  href: Type.String({ minLength: 1, maxLength: 2_048 }),
});

export const LobuViewSchema = Type.Object({
  version: Type.Literal(1),
  title: Type.Optional(Type.String({ maxLength: 200 })),
  tone: Type.Optional(
    Type.Union([Type.Literal('warning'), Type.Literal('default'), Type.Literal('bare')])
  ),
  blocks: Type.Array(LobuViewBlockSchema, { maxItems: 100 }),
  actions: Type.Array(LinkActionSchema, { maxItems: 10 }),
});

const RenderActionSchema = Type.Object({
  action: Type.Literal('render', {
    description:
      'Render a compact final card from model-selected data. Call Lobu data tools first; do not use this for ordinary text answers.',
  }),
  title: Type.Optional(Type.String({ maxLength: 200 })),
  tone: Type.Optional(
    Type.Union([Type.Literal('warning'), Type.Literal('default'), Type.Literal('bare')])
  ),
  blocks: Type.Array(LobuViewBlockSchema, { minItems: 1, maxItems: 100 }),
});

const ReviewApprovalActionSchema = Type.Object({
  action: Type.Literal('review_approval', {
    description:
      'Render the server-authored review card for one pending Lobu approval run. The card opens Lobu for the human decision.',
  }),
  run_id: Type.Integer({ minimum: 1 }),
});

export const RenderLobuViewSchema = Type.Union([
  RenderActionSchema,
  ReviewApprovalActionSchema,
]);

type RenderLobuViewArgs = Static<typeof RenderLobuViewSchema>;
type LobuView = Static<typeof LobuViewSchema>;

const SENSITIVE_KEY =
  /(?:^|[_-])(authorization|cookie|credential|password|secret|token|api[_-]?key)(?:$|[_-])/i;
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

function redactForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForDisplay);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[redacted]' : redactForDisplay(inner),
    ])
  );
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(redactForDisplay(value), null, 2);
}

function approvalBlocks(row: {
  content: string | null;
  interaction_input: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}): Static<typeof LobuViewBlockSchema>[] {
  const metadata = row.metadata ?? {};
  const proposal =
    metadata.proposal && typeof metadata.proposal === 'object'
      ? (metadata.proposal as Record<string, unknown>)
      : null;
  const current =
    metadata.current && typeof metadata.current === 'object'
      ? (metadata.current as Record<string, unknown>)
      : null;
  const fields =
    metadata.fields && typeof metadata.fields === 'object'
      ? (metadata.fields as Record<string, unknown>)
      : null;
  const proposed = fields ?? proposal;

  if (proposed) {
    const diffFields = Object.entries(proposed)
      .filter(([key, value]) => !DIFF_ROUTING_KEYS.has(key) && value !== undefined)
      .map(([key, value]) => ({
        label: key,
        ...(current && current[key] !== undefined
          ? { before: displayValue(current[key]) }
          : {}),
        after: displayValue(value),
      }));
    if (diffFields.length > 0) return [{ type: 'diff', fields: diffFields }];
  }

  if (row.interaction_input && Object.keys(row.interaction_input).length > 0) {
    return [
      {
        type: 'code',
        value: JSON.stringify(redactForDisplay(row.interaction_input), null, 2),
      },
    ];
  }

  return [
    {
      type: 'text',
      value: row.content || 'Review this pending Lobu action.',
      muted: true,
    },
  ];
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
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.run_id === runId && row.interaction_type === 'approval';
}

async function buildApprovalView(
  runId: number,
  env: Env,
  ctx: ToolContext
): Promise<LobuView> {
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
  const title = (row.title ?? `Approval run ${runId}`).replace(/\s+—\s+pending approval$/i, '');
  const actions: LobuView['actions'] = [];
  if (status === 'pending') {
    const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
    const href = buildResourcePermalink(ownerSlug, { kind: 'run', runId }, baseUrl);
    if (!href) {
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
    title: status === 'pending' ? title : `${title} · ${status}`,
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
    ...(args.title ? { title: args.title } : {}),
    ...(args.tone ? { tone: args.tone } : {}),
    blocks: args.blocks,
    actions: [],
  };
};

export const renderLobuView = withValidatedArgs(
  'render_lobu_view',
  RenderLobuViewSchema,
  renderLobuViewImpl
);
