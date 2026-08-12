import {
  decrypt,
  deepRedactSecrets,
  encrypt,
  isSecretKey,
  REDACTED_SENTINEL,
} from '@lobu/core';
import { type Static, Type } from '@sinclair/typebox';
import type { Env } from '../index';
import { ToolUserError } from '../utils/errors';
import { buildResourcePermalink } from '../utils/url-builder';
import { getContent } from './get_content';
import { manageOperations } from './admin/manage_operations';
import { attachMcpResultMeta } from './mcp-result-meta';
import type { ToolContext } from './registry';
import { withValidatedArgs } from './validate-args';
import { getOrgUrlContext } from './view-urls';

// The URI is the host cache key for the immutable template. Bump it whenever
// the shipped HTML changes; ChatGPT caches both successful and failed fetches.
export const LOBU_INTERACTION_RESOURCE_URI = 'ui://lobu/interaction/v12.html';

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
const APPROVAL_CAPABILITY_MAX_LENGTH = 4_096;
const APPROVAL_CAPABILITY_TTL_MS = 10 * 60 * 1_000;
const DISPLAY_REDACTION = '[redacted]';
const SECRET_SCHEMA_VALUE_KEYS = new Set(['const', 'default', 'enum', 'example', 'examples']);

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

const FormBlockSchema = Type.Object({
  type: Type.Literal('form'),
  schema: Type.Record(Type.String(), Type.Unknown()),
  initialValues: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const LobuViewBlockSchema = Type.Union([
  TextBlockSchema,
  CodeBlockSchema,
  DiffBlockSchema,
  FormBlockSchema,
]);

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

const ApprovalToolActionBaseFields = {
  label: Type.String({ minLength: 1, maxLength: ACTION_LABEL_MAX_LENGTH }),
  variant: Type.Optional(
    Type.Union([
      Type.Literal('primary'),
      Type.Literal('outline'),
      Type.Literal('ghost'),
      Type.Literal('destructive'),
    ])
  ),
  confirm: Type.Optional(Type.Boolean()),
  confirmPrompt: Type.Optional(Type.String({ maxLength: TEXT_LABEL_MAX_LENGTH })),
  terminal: Type.Optional(Type.Boolean()),
  resolvedLabel: Type.Optional(Type.String({ maxLength: TEXT_LABEL_MAX_LENGTH })),
} as const;

const ApprovalToolActionSchema = Type.Union([
  Type.Object({
    ...ApprovalToolActionBaseFields,
    id: Type.Literal('approve'),
    icon: Type.Optional(Type.Literal('check')),
    submitFormAs: Type.Optional(Type.Literal('input')),
    tool: Type.Literal('resolve_lobu_approval'),
    args: Type.Object({
      run_id: Type.Integer({ minimum: 1 }),
      decision: Type.Literal('approve'),
    }),
  }),
  Type.Object({
    ...ApprovalToolActionBaseFields,
    id: Type.Literal('reject'),
    icon: Type.Optional(Type.Literal('x')),
    tool: Type.Literal('resolve_lobu_approval'),
    args: Type.Object({
      run_id: Type.Integer({ minimum: 1 }),
      decision: Type.Literal('reject'),
    }),
  }),
]);

export const LobuViewSchema = Type.Object({
  version: Type.Literal(1),
  title: Type.Optional(Type.String({ maxLength: TITLE_MAX_LENGTH })),
  tone: Type.Optional(
    Type.Union([Type.Literal('warning'), Type.Literal('default'), Type.Literal('bare')])
  ),
  blocks: Type.Array(LobuViewBlockSchema, { maxItems: BLOCK_MAX_ITEMS }),
  actions: Type.Array(Type.Union([LinkActionSchema, ApprovalToolActionSchema]), {
    maxItems: ACTION_MAX_ITEMS,
  }),
});

export const ResolveLobuApprovalSchema = Type.Object({
  run_id: Type.Integer({ minimum: 1 }),
  decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]),
  input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  reason: Type.Optional(Type.String({ maxLength: 2_000 })),
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

function stripSecretSchemaValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecretSchemaValues);
  if (!isRecord(value)) return redactForDisplay(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_SCHEMA_VALUE_KEYS.has(key))
      .map(([key, inner]) => [key, stripSecretSchemaValues(inner)])
  );
}

function sanitizeFormFieldSchema(name: string, value: unknown): unknown {
  const sanitized = sanitizeFormSchema(value);
  if (!isSecretKey(name)) return sanitized;
  if (!isRecord(sanitized)) return DISPLAY_REDACTION;

  const field = stripSecretSchemaValues(sanitized) as Record<string, unknown>;
  if (field.type === 'string' || field.type === undefined) field.format = 'password';
  return field;
}

/** Preserve usable JSON Schema structure while removing secret-bearing values. */
function sanitizeFormSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeFormSchema);
  if (!isRecord(value)) return redactForDisplay(value);

  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => {
      if (key === 'properties' && isRecord(inner)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(inner).map(([name, schema]) => [
              name,
              sanitizeFormFieldSchema(name, schema),
            ])
          ),
        ];
      }
      return [key, sanitizeFormSchema(inner)];
    })
  );
}

function sanitizeFormInitialValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeFormInitialValue);
  if (!isRecord(value)) return redactForDisplay(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSecretKey(key))
      .map(([key, inner]) => [key, sanitizeFormInitialValue(inner)])
  );
}

function sanitizeFormInitialValues(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeFormInitialValue(value) as Record<string, unknown>;
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
  interaction_input_schema: Record<string, unknown> | null;
  interaction_input: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}): LobuViewBlock[] {
  const metadata = row.metadata ?? {};
  const proposal = isRecord(metadata.proposal) ? metadata.proposal : null;
  const current = isRecord(metadata.current) ? metadata.current : null;
  const fields = isRecord(metadata.fields) ? metadata.fields : null;
  const proposed = fields ?? proposal;
  const blocks: LobuViewBlock[] = [];

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
    if (diffFields.length > 0) blocks.push({ type: 'diff', fields: diffFields });
  }

  if (row.interaction_input_schema) {
    blocks.push({
      type: 'form',
      schema: sanitizeFormSchema(row.interaction_input_schema) as Record<string, unknown>,
      ...(row.interaction_input
        ? {
            initialValues: sanitizeFormInitialValues(row.interaction_input),
          }
        : {}),
    });
  } else if (row.interaction_input && Object.keys(row.interaction_input).length > 0) {
    blocks.push({
      type: 'code',
      value: displayValue(row.interaction_input, CODE_VALUE_MAX_LENGTH),
    });
  }

  if (blocks.length === 0) {
    blocks.push({
      type: 'text',
      value: displayValue(row.content || 'Review this pending Lobu action.', TEXT_VALUE_MAX_LENGTH),
      muted: true,
    });
  }
  return blocks;
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
    if (block.type === 'form') {
      return {
        type: 'form',
        schema: sanitizeFormSchema(block.schema) as Record<string, unknown>,
        ...(block.initialValues
          ? {
              initialValues: sanitizeFormInitialValues(block.initialValues),
            }
          : {}),
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
  id: number;
  run_id: number;
  title: string | null;
  payload_text: string;
  interaction_type: 'approval';
  interaction_status: string | null;
  interaction_input_schema: Record<string, unknown> | null;
  interaction_input: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

function isApprovalContentItem(value: unknown, runId: number): value is ApprovalContentItem {
  if (!isRecord(value)) return false;
  return value.run_id === runId && value.interaction_type === 'approval';
}

function belongsToApprovalWindow(row: ApprovalContentItem): boolean {
  const windowId = row.metadata?.window_id;
  return windowId !== undefined && windowId !== null;
}

type ApprovalCapability = {
  v: 1;
  runId: number;
  eventId: number;
  organizationId: string;
  userId: string;
  clientId: string;
  sessionId: string;
  expiresAt: number;
};

function isApprovalCapability(value: unknown): value is ApprovalCapability {
  if (!isRecord(value)) return false;
  return (
    value.v === 1 &&
    Number.isInteger(value.runId) &&
    Number.isInteger(value.eventId) &&
    typeof value.organizationId === 'string' &&
    typeof value.userId === 'string' &&
    typeof value.clientId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.expiresAt === 'number'
  );
}

function canIssueApprovalCapability(
  row: ApprovalContentItem,
  status: string,
  ctx: ToolContext
): ctx is ToolContext & {
  userId: string;
  clientId: string;
  mcpSessionId: string;
} {
  return (
    status === 'pending' &&
    ctx.mcpAppsSupported === true &&
    ctx.tokenType === 'oauth' &&
    Boolean(ctx.userId && ctx.clientId && ctx.mcpSessionId) &&
    !belongsToApprovalWindow(row)
  );
}

function issueApprovalCapability(row: ApprovalContentItem, ctx: ToolContext): string {
  const payload: ApprovalCapability = {
    v: 1,
    runId: row.run_id,
    eventId: row.id,
    organizationId: ctx.organizationId,
    userId: ctx.userId!,
    clientId: ctx.clientId!,
    sessionId: ctx.mcpSessionId!,
    expiresAt: Date.now() + APPROVAL_CAPABILITY_TTL_MS,
  };
  return encrypt(JSON.stringify(payload));
}

function readApprovalCapability(token: string | null | undefined): ApprovalCapability {
  if (!token || token.length > APPROVAL_CAPABILITY_MAX_LENGTH) {
    throw new ToolUserError('A valid MCP App approval capability is required.', 403);
  }
  try {
    const parsed: unknown = JSON.parse(decrypt(token));
    if (!isApprovalCapability(parsed)) throw new Error('invalid payload');
    return parsed;
  } catch {
    throw new ToolUserError('The MCP App approval capability is invalid or expired.', 403);
  }
}

async function findApprovalRow(
  runId: number,
  env: Env,
  ctx: ToolContext
): Promise<ApprovalContentItem> {
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
  return row;
}

async function buildApprovalView(runId: number, env: Env, ctx: ToolContext): Promise<LobuView> {
  const row = await findApprovalRow(runId, env, ctx);

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
    const appCanResolve = canIssueApprovalCapability(row, status, ctx);
    if (appCanResolve) {
      actions.push(
        {
          id: 'approve',
          label: 'Approve',
          variant: 'primary',
          icon: 'check',
          resolvedLabel: 'Approved.',
          ...(row.interaction_input_schema ? { submitFormAs: 'input' as const } : {}),
          tool: 'resolve_lobu_approval',
          args: { run_id: runId, decision: 'approve' },
        },
        {
          id: 'reject',
          label: 'Reject',
          variant: 'destructive',
          icon: 'x',
          confirm: true,
          confirmPrompt: 'Reject this pending action?',
          resolvedLabel: 'Rejected.',
          tool: 'resolve_lobu_approval',
          args: { run_id: runId, decision: 'reject' },
        }
      );
    }
    actions.push({
      id: 'review',
      label: 'Open in Lobu',
      variant: appCanResolve ? 'outline' : 'primary',
      icon: 'external',
      terminal: false,
      href,
    });
  }

  const view: LobuView = {
    version: 1,
    title: truncate(
      status === 'pending' ? baseTitle : `${baseTitle} · ${status}`,
      TITLE_MAX_LENGTH
    ),
    tone: status === 'pending' ? 'warning' : 'default',
    blocks: approvalBlocks({
      content: row.payload_text,
      interaction_input_schema: row.interaction_input_schema,
      interaction_input: row.interaction_input,
      metadata: row.metadata,
    }),
    actions,
  };
  if (canIssueApprovalCapability(row, status, ctx)) {
    return attachMcpResultMeta(view, {
      'lobu/approval-capability': issueApprovalCapability(row, ctx),
    });
  }
  return view;
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

type ResolveLobuApprovalArgs = Static<typeof ResolveLobuApprovalSchema>;

const resolveLobuApprovalImpl = async (
  args: ResolveLobuApprovalArgs,
  env: Env,
  ctx: ToolContext
): Promise<LobuView> => {
  const capability = readApprovalCapability(ctx.mcpAppApprovalCapability);
  if (
    capability.runId !== args.run_id ||
    ctx.mcpAppsSupported !== true ||
    capability.organizationId !== ctx.organizationId ||
    capability.userId !== ctx.userId ||
    capability.clientId !== ctx.clientId ||
    capability.sessionId !== ctx.mcpSessionId ||
    capability.expiresAt <= Date.now()
  ) {
    throw new ToolUserError('The MCP App approval capability is stale or does not match.', 403);
  }

  const current = await findApprovalRow(args.run_id, env, ctx);
  if (current.interaction_status !== 'pending' || current.id !== capability.eventId) {
    throw new ToolUserError('This approval capability is stale; the run is no longer pending.', 409);
  }
  if (belongsToApprovalWindow(current)) {
    throw new ToolUserError('Batched proposals must be reviewed in Lobu.', 409);
  }

  // The encrypted capability proves a signed-in OAuth user deliberately used
  // this app surface. The canonical approval handler still performs its own
  // membership and run-owner/admin authority checks; clear only the non-human
  // transport identities after the capability has been fully revalidated.
  const humanContext: ToolContext = {
    ...ctx,
    agentId: null,
    clientId: null,
    mcpSessionId: null,
    mcpAppApprovalCapability: null,
    mcpAppSnapshotCapability: null,
  };
  const result = await manageOperations(
    args.decision === 'approve'
      ? { action: 'approve', run_id: args.run_id, ...(args.input ? { input: args.input } : {}) }
      : { action: 'reject', run_id: args.run_id, ...(args.reason ? { reason: args.reason } : {}) },
    env,
    humanContext
  );
  if ('error' in result && typeof result.error === 'string') {
    throw new ToolUserError(result.error, 409);
  }
  return buildApprovalView(args.run_id, env, ctx);
};

export const resolveLobuApproval = withValidatedArgs(
  'resolve_lobu_approval',
  ResolveLobuApprovalSchema,
  resolveLobuApprovalImpl
);
