import {
  decrypt,
  deepRedactSecrets,
  encrypt,
  isSecretKey,
  REDACTED_SENTINEL,
} from '@lobu/core';
import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../db/client';
import type { Env } from '../index';
import {
  type ActionOrigin,
  actionOriginLabel,
  formatUtc,
} from '../notifications/action-card-state';
import { resolveInteractionActionOrigin } from '../notifications/action-origin';
import { ToolUserError } from '../utils/errors';
import { buildResourcePermalink } from '../utils/url-builder';
import {
  AccessDeniedError,
  CrossOrgAccessDenied,
  OrgNotFoundError,
  resolveCrossOrgToolContext,
} from '../sandbox/client-sdk';
import { getContent } from './get_content';
import { manageOperations } from './admin/manage_operations';
import { attachMcpResultMeta } from './mcp-result-meta';
import type { ToolContext } from './registry';
import { withValidatedArgs } from './validate-args';
import { getOrgUrlContext } from './view-urls';

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
    tool: Type.Literal('resolve_approval'),
    args: Type.Object({
      run_id: Type.Integer({ minimum: 1 }),
      decision: Type.Literal('approve'),
    }),
  }),
  Type.Object({
    ...ApprovalToolActionBaseFields,
    id: Type.Literal('reject'),
    icon: Type.Optional(Type.Literal('x')),
    tool: Type.Literal('resolve_approval'),
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

export const ResolveApprovalSchema = Type.Object({
  run_id: Type.Integer({ minimum: 1 }),
  decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]),
  input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  reason: Type.Optional(Type.String({ maxLength: 2_000 })),
});

export const GetApprovalSchema = Type.Object({
  run_id: Type.Integer({ minimum: 1 }),
  organization: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Target workspace slug or id. Available only to unscoped OAuth sessions.',
    })
  ),
});

type LobuView = Static<typeof LobuViewSchema>;
type LobuViewBlock = Static<typeof LobuViewBlockSchema>;

const DIFF_ROUTING_KEYS = new Set([
  'action',
  'agent_id',
  'base',
  'automation_id',
  'entity_id',
  'id',
  'owner_user_id',
  'reason',
  'automation_id',
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
  interaction_output: Record<string, unknown> | null;
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
    const submittedAnswer = isRecord(row.interaction_output?.answer)
      ? row.interaction_output.answer
      : null;
    const formValues = submittedAnswer ?? row.interaction_input;
    blocks.push({
      type: 'form',
      schema: sanitizeFormSchema(row.interaction_input_schema) as Record<string, unknown>,
      ...(formValues
        ? {
            initialValues: sanitizeFormInitialValues(formValues),
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

type ApprovalContentItem = {
  id: number;
  run_id: number;
  created_at: string;
  client_id: string | null;
  agent_id: string | null;
  automation_id: number | null;
  title: string | null;
  payload_text: string;
  interaction_type: 'approval';
  interaction_status: string | null;
  interaction_input_schema: Record<string, unknown> | null;
  interaction_input: Record<string, unknown> | null;
  interaction_output: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function approvalDecisionBlock(
  row: ApprovalContentItem,
  status: string
): LobuViewBlock | null {
  if (status === 'pending') return null;
  const reviewer =
    typeof row.metadata?.reviewed_by_name === 'string'
      ? row.metadata.reviewed_by_name.trim()
      : '';
  // A decision appends a NEW event version (supersedeActionEvent), so this
  // row's created_at is the decision time for cards written before
  // `reviewed_at` was stamped.
  const timestamp =
    formatUtc(
      typeof row.metadata?.reviewed_at === 'string' ? row.metadata.reviewed_at : row.created_at
    ) ?? '';
  const decisionStatus =
    row.metadata?.reviewed_at && (status === 'completed' || status === 'failed')
      ? 'approved'
      : status;
  const decision = `${decisionStatus.charAt(0).toUpperCase()}${decisionStatus.slice(1)}`;
  return {
    type: 'text',
    label: 'Decision',
    value: `${decision}${reviewer ? ` by ${reviewer}` : ''}${timestamp ? ` · ${timestamp}` : ''}`,
    muted: true,
  };
}

async function approvalOrigin(row: ApprovalContentItem, ctx: ToolContext): Promise<ActionOrigin> {
  const runs = await getDb()<{
    automation_id: number | null;
    initiator_ref: Record<string, unknown> | null;
    original_client_id: string | null;
  }>`
    SELECT r.automation_id, r.initiator_ref, original.client_id AS original_client_id
    FROM runs r
    LEFT JOIN LATERAL (
      SELECT e.client_id
      FROM events e
      WHERE e.run_id = r.id
        AND e.organization_id = r.organization_id
        AND e.interaction_type = 'approval'
      ORDER BY e.id ASC
      LIMIT 1
    ) original ON true
    WHERE r.id = ${row.run_id} AND r.organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  const metadata = row.metadata ?? {};
  const initiator = isRecord(metadata.initiator)
    ? metadata.initiator
    : (runs[0]?.initiator_ref ?? {});
  const automationId =
    Number(runs[0]?.automation_id ?? row.automation_id ?? initiator.automation_id ?? 0) || null;
  // The MCP activity row is keyed by the host conversation id when the host
  // exposes one and by the transport session id when it does not — the same
  // choice `currentMcpActivityAttribution` made when the row was written.
  const mcpActivityId =
    stringOrNull(metadata.mcp_conversation_id) ?? stringOrNull(metadata.mcp_session_id);
  const conversationId = mcpActivityId ?? stringOrNull(initiator.conversation_id);
  if (!automationId && !conversationId) return { kind: 'direct', label: 'Direct request' };
  return resolveInteractionActionOrigin({
    organizationId: ctx.organizationId,
    automationId,
    conversationId,
    // get_content's `platform` column carries the event's connector_key, never a
    // chat platform, so it is deliberately not a fallback here.
    platform: mcpActivityId ? 'mcp' : stringOrNull(initiator.platform),
    clientIdentity:
      ctx.memberRole != null
        ? (stringOrNull(initiator.client_id) ?? row.client_id ?? runs[0]?.original_client_id ?? null)
        : null,
    agentId: row.agent_id ?? stringOrNull(initiator.agent_id),
  });
}

function approvalOriginBlock(origin: ActionOrigin): LobuViewBlock {
  return {
    type: 'text',
    label: actionOriginLabel(origin.kind),
    value: displayValue(origin.label, TEXT_VALUE_MAX_LENGTH),
    muted: true,
  };
}

function isApprovalContentItem(value: unknown, runId: number): value is ApprovalContentItem {
  if (!isRecord(value)) return false;
  return value.run_id === runId && value.interaction_type === 'approval';
}

function belongsToApprovalBatch(row: ApprovalContentItem): boolean {
  const sourceRunId = row.metadata?.source_run_id;
  return sourceRunId !== undefined && sourceRunId !== null;
}

type ApprovalCapability = {
  v: 2;
  runId: number;
  eventId: number;
  organizationId: string;
  userId: string;
  clientId: string;
  sessionId: string;
  conversationId?: string | null;
  expiresAt: number;
};

function isApprovalCapability(value: unknown): value is ApprovalCapability {
  if (!isRecord(value)) return false;
  return (
    value.v === 2 &&
    Number.isInteger(value.runId) &&
    Number.isInteger(value.eventId) &&
    typeof value.organizationId === 'string' &&
    typeof value.userId === 'string' &&
    typeof value.clientId === 'string' &&
    typeof value.sessionId === 'string' &&
    (value.conversationId === null || typeof value.conversationId === 'string') &&
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
  // Deliberately NOT gated on `ctx.mcpAppsSupported`. That flag answers "did
  // the client announce the Apps extension", which is a different question
  // from "can this client render a card and call back through it" — claude.ai
  // renders while announcing nothing, so gating here left its card showing
  // Approve/Reject it could never obtain the right to press.
  //
  // This widens who receives the capability without widening what it reaches:
  // the token stays bound to org/user/client/session with a TTL, and
  // `resolve_approval` stays absent from `tools/list` for a non-declaring
  // client, so the model cannot invoke it — only the rendered card can, via
  // `tools/call`. The conditions kept below are the ones carrying real weight.
  return (
    status === 'pending' &&
    ctx.tokenType === 'oauth' &&
    Boolean(ctx.userId && ctx.clientId && ctx.mcpSessionId) &&
    !belongsToApprovalBatch(row)
  );
}

function issueApprovalCapability(row: ApprovalContentItem, ctx: ToolContext): string {
  const payload: ApprovalCapability = {
    v: 2,
    runId: row.run_id,
    eventId: row.id,
    organizationId: ctx.organizationId,
    userId: ctx.userId!,
    clientId: ctx.clientId!,
    sessionId: ctx.mcpSessionId!,
    conversationId: ctx.mcpConversationId ?? null,
    expiresAt: Date.now() + APPROVAL_CAPABILITY_TTL_MS,
  };
  return encrypt(JSON.stringify(payload));
}

function approvalCapabilityMatchesHost(capability: ApprovalCapability, ctx: ToolContext): boolean {
  if (capability.conversationId) {
    return capability.conversationId === ctx.mcpConversationId;
  }
  return capability.sessionId === ctx.mcpSessionId;
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
  const origin = await approvalOrigin(row, ctx).catch(() => ({
    kind: 'direct' as const,
    label: 'Direct request',
  }));

  const status = row.interaction_status ?? 'pending';
  const decisionBlock = approvalDecisionBlock(row, status);
  const baseTitle = displayValue(row.title ?? `Approval run ${runId}`, TITLE_MAX_LENGTH).replace(
    /\s+—\s+(?:pending approval|approved|rejected|completed|failed|cancelled)$/i,
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
          tool: 'resolve_approval',
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
          tool: 'resolve_approval',
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
    blocks: [
      ...approvalBlocks({
        content: row.payload_text,
        interaction_input_schema: row.interaction_input_schema,
        interaction_input: row.interaction_input,
        interaction_output: row.interaction_output,
        metadata: row.metadata,
      }),
      approvalOriginBlock(origin),
      ...(decisionBlock ? [decisionBlock] : []),
    ],
    actions,
  };
  return attachMcpResultMeta(view, {
    // A cross-org card is rendered for the target workspace. Keep the app's
    // role display aligned with the same target context that authored actions.
    'lobu/member-role': ctx.memberRole,
    ...(canIssueApprovalCapability(row, status, ctx)
      ? { 'lobu/approval-capability': issueApprovalCapability(row, ctx) }
      : {}),
  });
}

/**
 * Resolve a target workspace for an MCP-App tool call. `resolveCrossOrgToolContext`
 * reports denial with the SDK's typed errors, which only the sandbox translates;
 * at a plain tool boundary they would surface as a generic failure. Re-raise them
 * as ToolUserErrors so REST and MCP agree on the status — 403 for denial, matching
 * the sibling stale-capability check, and 404 for an unknown workspace.
 */
async function resolveApprovalWorkspace(
  slugOrId: string,
  ctx: ToolContext
): Promise<ToolContext> {
  try {
    return await resolveCrossOrgToolContext(slugOrId, ctx);
  } catch (error) {
    if (
      error instanceof CrossOrgAccessDenied ||
      error instanceof AccessDeniedError
    ) {
      throw new ToolUserError(error.message, 403);
    }
    if (error instanceof OrgNotFoundError) {
      throw new ToolUserError(error.message, 404);
    }
    throw error;
  }
}

const getApprovalImpl = async (
  args: Static<typeof GetApprovalSchema>,
  env: Env,
  ctx: ToolContext
): Promise<LobuView> => {
  const approvalCtx = args.organization
    ? await resolveApprovalWorkspace(args.organization, ctx)
    : ctx;
  return buildApprovalView(args.run_id, env, approvalCtx);
};

export const getApproval = withValidatedArgs(
  'get_approval',
  GetApprovalSchema,
  getApprovalImpl
);

type ResolveApprovalArgs = Static<typeof ResolveApprovalSchema>;

const resolveApprovalImpl = async (
  args: ResolveApprovalArgs,
  env: Env,
  ctx: ToolContext
): Promise<LobuView> => {
  const capability = readApprovalCapability(ctx.mcpAppApprovalCapability);
  // Drops `ctx.mcpAppsSupported` for the same reason issuance does — and it
  // has to drop it in the SAME change, or a card holding a freshly-issued
  // capability gets a 403 on every press. What remains authenticates the round
  // trip: the capability must name this run, user and client, still be
  // bound to the calling host, and not have expired.
  if (
    capability.runId !== args.run_id ||
    capability.userId !== ctx.userId ||
    capability.clientId !== ctx.clientId ||
    !approvalCapabilityMatchesHost(capability, ctx) ||
    capability.expiresAt <= Date.now()
  ) {
    throw new ToolUserError('The MCP App approval capability is stale or does not match.', 403);
  }

  // The encrypted card capability carries the authoritative workspace. An
  // unscoped OAuth session may resolve it under the same login; scoped/PAT
  // connections remain unable to cross their bound workspace.
  const approvalCtx =
    capability.organizationId === ctx.organizationId
      ? ctx
      : await resolveApprovalWorkspace(capability.organizationId, ctx);

  const current = await findApprovalRow(args.run_id, env, approvalCtx);
  if (current.interaction_status !== 'pending' || current.id !== capability.eventId) {
    throw new ToolUserError('This approval capability is stale; the run is no longer pending.', 409);
  }
  if (belongsToApprovalBatch(current)) {
    throw new ToolUserError('Batched proposals must be reviewed in Lobu.', 409);
  }

  // The encrypted capability proves a signed-in OAuth user deliberately used
  // this app surface. The canonical approval handler still performs its own
  // membership and run-owner/admin authority checks; clear only the non-human
  // transport identities after the capability has been fully revalidated.
  const humanContext: ToolContext = {
    ...approvalCtx,
    agentId: null,
    clientId: null,
    mcpSessionId: null,
    mcpAppApprovalCapability: null,
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
  return buildApprovalView(args.run_id, env, approvalCtx);
};

export const resolveApproval = withValidatedArgs(
  'resolve_approval',
  ResolveApprovalSchema,
  resolveApprovalImpl
);
