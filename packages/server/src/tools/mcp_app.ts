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
  /(?:^|[_-])(authorization|cookie|credential|password|private[_-]?key|secret|token|api[_-]?key)(?:$|[_-])/i;
const KNOWN_SECRET_SHAPE_RE =
  /\b(?:sk[-_][a-z0-9_-]{8,}|xox[baprs]-[a-z0-9-]{8,}|gh[pousr]_[a-z0-9_]{12,}|AKIA[A-Z0-9]{16}|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})\b/gi;
const HEADER_CREDENTIAL_RE =
  /\b(authorization|proxy-authorization|www-authenticate|set-cookie|cookie)\s*["']?\s*[:=]\s*[^\n]+/gi;
const AUTH_SCHEME_RE =
  /\b(bearer|basic|digest)\s+(?:[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,]+)(?:\s*,\s*[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,]+))*|[a-z0-9._~+/=:-]+)/gi;
const SENSITIVE_ASSIGNMENT_RE =
  /(api[_-]?key|credential|password|private[_-]?key|secret|token)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s'"}]+)/gi;
const MAX_TEXT_LENGTH = 20_000;
const MAX_CODE_LENGTH = 40_000;
const MAX_LABEL_LENGTH = 120;
const MAX_TITLE_LENGTH = 200;
const DIFF_ROUTING_KEYS = new Set([
  'action',
  'agent_id',
  'acting_agent_id',
  'acting_watcher_id',
  'args',
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

function isSensitiveKey(key: string): boolean {
  const snakeCase = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return SENSITIVE_KEY.test(snakeCase);
}

function isDiffRoutingKey(key: string): boolean {
  const snakeCase = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return DIFF_ROUTING_KEYS.has(snakeCase);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(HEADER_CREDENTIAL_RE, (_match, key: string) => `${key}=[redacted]`)
    .replace(AUTH_SCHEME_RE, (_match, scheme: string) => `${scheme} [redacted]`)
    .replace(SENSITIVE_ASSIGNMENT_RE, (_match, key: string) => `${key}=[redacted]`)
    .replace(KNOWN_SECRET_SHAPE_RE, '[redacted]');
}

function truncateRedactedText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function truncateForDisplay(value: string, maxLength: number): string {
  return truncateRedactedText(redactSensitiveText(value), maxLength);
}

function redactForDisplay(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactForDisplay);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      isSensitiveKey(key) ? '[redacted]' : redactForDisplay(inner),
    ])
  );
}

function displayValue(value: unknown, maxLength = MAX_TEXT_LENGTH): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return truncateForDisplay(value, maxLength);
  const serialized = JSON.stringify(redactForDisplay(value), null, 2);
  return truncateRedactedText(serialized ?? String(value), maxLength);
}

function sanitizeBlock(
  block: Static<typeof LobuViewBlockSchema>
): Static<typeof LobuViewBlockSchema> {
  if (block.type === 'text') {
    return {
      ...block,
      ...(block.label !== undefined
        ? { label: truncateForDisplay(block.label, MAX_LABEL_LENGTH) }
        : {}),
      value: truncateForDisplay(block.value, MAX_TEXT_LENGTH),
    };
  }
  if (block.type === 'code') {
    return { ...block, value: truncateForDisplay(block.value, MAX_CODE_LENGTH) };
  }
  return {
    ...block,
    fields: block.fields.map((field) => ({
      label: truncateForDisplay(field.label, MAX_LABEL_LENGTH) || 'Field',
      ...(field.before !== undefined
        ? { before: truncateForDisplay(field.before, MAX_TEXT_LENGTH) }
        : {}),
      after: truncateForDisplay(field.after, MAX_TEXT_LENGTH),
    })),
  };
}

function approvalBlocks(row: {
  content: string | null;
  interaction_input: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}): Static<typeof LobuViewBlockSchema>[] {
  const metadata = row.metadata ?? {};
  const proposal = isRecord(metadata.proposal) ? metadata.proposal : null;
  const proposalArgs = proposal && isRecord(proposal.args) ? proposal.args : null;
  const current = isRecord(metadata.current) ? metadata.current : null;
  const fields = isRecord(metadata.fields) ? metadata.fields : null;
  // Prefer the producer-authored review fields. Some approval proposals (most
  // notably manage_behaviors) are execution envelopes shaped as
  // `{ args, actingAgentId, actingWatcherId }`; rendering that envelope leaks
  // routing details and hides the actual field-level change.
  const proposed = fields ?? row.interaction_input ?? proposalArgs ?? proposal;

  if (proposed) {
    const diffFields = Object.entries(proposed)
      .filter(([key, value]) => !isDiffRoutingKey(key) && value !== undefined)
      .slice(0, 100)
      .map(([key, value]) => ({
        label: truncateForDisplay(key, MAX_LABEL_LENGTH) || 'Field',
        ...(current && current[key] !== undefined
          ? {
              before: isSensitiveKey(key)
                ? '[redacted]'
                : displayValue(current[key]),
            }
          : {}),
        after: isSensitiveKey(key) ? '[redacted]' : displayValue(value),
      }));
    if (diffFields.length > 0) return [{ type: 'diff', fields: diffFields }];
  }

  if (row.interaction_input && Object.keys(row.interaction_input).length > 0) {
    return [
      {
        type: 'code',
        value: displayValue(row.interaction_input, MAX_CODE_LENGTH),
      },
    ];
  }

  return [
    {
      type: 'text',
      value: truncateForDisplay(
        row.content || 'Review this pending Lobu action.',
        MAX_TEXT_LENGTH
      ),
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
  const baseTitle = (row.title ?? `Approval run ${runId}`).replace(
    /\s+—\s+pending approval$/i,
    ''
  );
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
    title: truncateForDisplay(
      status === 'pending' ? baseTitle : `${baseTitle} · ${status}`,
      MAX_TITLE_LENGTH
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
    ...(args.title !== undefined
      ? { title: truncateForDisplay(args.title, MAX_TITLE_LENGTH) }
      : {}),
    ...(args.tone ? { tone: args.tone } : {}),
    blocks: args.blocks.map(sanitizeBlock),
    actions: [],
  };
};

export const renderLobuView = withValidatedArgs(
  'render_lobu_view',
  RenderLobuViewSchema,
  renderLobuViewImpl
);
