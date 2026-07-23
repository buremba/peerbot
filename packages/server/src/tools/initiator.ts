/**
 * Run provenance — deriving WHO caused a turn, in one place.
 *
 * Every writer used to reassemble this itself out of
 * `ctx.actingWatcherId ?? args.behavior_source?.behavior_id`, an expression that
 * can only name a behavior; MCP/agent sessions fell through to null and their
 * runs became orphans. Both functions here are pure so the derivation is
 * testable without a database and identical at every call site.
 *
 * Provenance only. Authorization stays with `resolveActingPrincipal`.
 */

import type { ToolContext, ToolInitiator } from './registry';

/**
 * The fields provenance is derived from — the subset of {@link ToolContext} that
 * carries verified identity. Narrowed so entry points can derive an initiator
 * while still assembling the rest of the context, without casting.
 */
export type InitiatorSource = Pick<
  ToolContext,
  | 'userId'
  | 'agentId'
  | 'clientId'
  | 'sourceContext'
  | 'actingWatcherId'
  | 'actingWindowId'
  | 'actingRunId'
  | 'initiator'
>;

/**
 * The initiator for a turn. Prefers one the entry point already stamped;
 * otherwise infers it from verified context fields, most specific first.
 *
 * Order matters. A reaction runs with BOTH `actingWatcherId` and an `agentId`
 * (its owning agent), so the behavior check has to come first or every behavior
 * would be misfiled as an agent session. A human session carries neither.
 */
export function resolveInitiator(ctx: InitiatorSource): ToolInitiator {
  if (ctx.initiator) return ctx.initiator;

  if (ctx.actingWatcherId != null) {
    return {
      kind: 'behavior',
      watcherId: ctx.actingWatcherId,
      windowId: ctx.actingWindowId ?? null,
      runId: ctx.actingRunId ?? null,
    };
  }

  // An agent id means a non-human drove the call, even when it acts under a
  // human's session — keep the userId so the human stays recoverable.
  if (ctx.agentId) {
    return {
      kind: 'agent_session',
      agentId: ctx.agentId,
      userId: ctx.userId ?? null,
      clientId: ctx.clientId ?? null,
      conversationId: ctx.sourceContext?.conversationId ?? null,
    };
  }

  if (ctx.userId) return { kind: 'user', userId: ctx.userId };

  // Internal callers that build a context by hand (backfills, system tasks).
  return { kind: 'system' };
}

/** The `runs` columns for an initiator: the kind, its identifiers, and the
 * human to attribute the run to (FK to `user`, so only a real user id). */
export function initiatorRunColumns(initiator: ToolInitiator): {
  initiatorKind: string;
  initiatorRef: Record<string, unknown>;
  createdByUserId: string | null;
} {
  switch (initiator.kind) {
    case 'user':
      return {
        initiatorKind: 'user',
        initiatorRef: { user_id: initiator.userId },
        createdByUserId: initiator.userId,
      };
    case 'behavior':
      return {
        initiatorKind: 'behavior',
        initiatorRef: {
          watcher_id: initiator.watcherId,
          window_id: initiator.windowId,
          run_id: initiator.runId,
        },
        // A behavior runs autonomously — attributing it to the human who
        // happens to own it would misreport an unattended run as theirs.
        createdByUserId: null,
      };
    case 'agent_session':
      return {
        initiatorKind: 'agent_session',
        initiatorRef: {
          agent_id: initiator.agentId,
          user_id: initiator.userId,
          client_id: initiator.clientId,
          conversation_id: initiator.conversationId,
        },
        createdByUserId: initiator.userId,
      };
    case 'schedule':
      return {
        initiatorKind: 'schedule',
        initiatorRef: {
          schedule_id: initiator.scheduleId,
          run_id: initiator.runId,
        },
        createdByUserId: null,
      };
    case 'system':
      return {
        initiatorKind: 'system',
        initiatorRef: {},
        createdByUserId: null,
      };
  }
}
