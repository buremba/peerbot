import type { LandingUseCaseId } from "../use-case-definitions";

/**
 * Fan-in / fan-out visualisation for the Watchers section.
 *
 * Left column: 5 event types that the watcher fires on (or extracts from).
 * Center: the watcher webhook handle.
 * Right column: 5 actions / reactions the watcher emits.
 *
 * SVG lines connect every trigger to the center and the center to every
 * action; one trigger + one action highlighted to suggest a hot path.
 */

type WatcherShape = {
  watcherName: string;
  triggers: string[];
  actions: string[];
};

const WATCHERS: Record<LandingUseCaseId, WatcherShape> = {
  legal: {
    watcherName: "contract-clause-review",
    triggers: [
      "docusign.envelope.completed",
      "gmail.message.received",
      "drive.file.created",
      "slack.message.created",
      "github.pr.opened",
    ],
    actions: [
      "save_knowledge(Contract)",
      "save_knowledge(Clause)",
      "slack.post_message(#legal)",
      "linear.create_issue(review)",
      "gmail.send_draft(counterparty)",
    ],
  },
  finance: {
    watcherName: "reconciliation-monitor",
    triggers: [
      "quickbooks.transaction.posted",
      "stripe.charge.succeeded",
      "ramp.expense.created",
      "plaid.balance.refreshed",
      "csv.upload.received",
    ],
    actions: [
      "save_knowledge(Transaction)",
      "save_knowledge(Reconciliation)",
      "slack.post_message(#finance)",
      "linear.create_issue(unmatched)",
      "gmail.send_draft(vendor)",
    ],
  },
  sales: {
    watcherName: "account-health-monitor",
    triggers: [
      "salesforce.opportunity.updated",
      "gong.call.ended",
      "linear.issue.created",
      "intercom.conversation.replied",
      "hubspot.deal.stage_changed",
    ],
    actions: [
      "save_knowledge(Opportunity)",
      "save_knowledge(AccountHealth)",
      "slack.post_message(#sales-pods)",
      "salesforce.update_opportunity",
      "gmail.send_draft(account_owner)",
    ],
  },
  delivery: {
    watcherName: "at-risk-shipment",
    triggers: [
      "shopify.order.fulfilled",
      "fedex.tracking.updated",
      "stripe.refund.created",
      "intercom.conversation.created",
      "gmail.message.received",
    ],
    actions: [
      "save_knowledge(Shipment)",
      "save_knowledge(Incident)",
      "slack.post_message(#ops)",
      "intercom.reply_message",
      "shopify.update_order",
    ],
  },
  leadership: {
    watcherName: "weekly-execution-digest",
    triggers: [
      "linear.issue.state_changed",
      "github.pr.merged",
      "notion.doc.updated",
      "slack.channel.summary",
      "gcal.meeting.ended",
    ],
    actions: [
      "save_knowledge(Initiative)",
      "save_knowledge(Cycle)",
      "slack.post_message(#leadership)",
      "notion.append_block(digest)",
      "linear.create_issue(blocker)",
    ],
  },
  "agent-community": {
    watcherName: "opportunity-matcher",
    triggers: [
      "discourse.post.created",
      "github.discussion.opened",
      "hackernews.story.commented",
      "linear.issue.created",
      "slack.message.created",
    ],
    actions: [
      "save_knowledge(Member)",
      "save_knowledge(Opportunity)",
      "slack.dm_member(intro)",
      "discourse.send_message",
      "notion.append_block(roster)",
    ],
  },
  ecommerce: {
    watcherName: "refund-pattern-detector",
    triggers: [
      "stripe.charge.refunded",
      "shopify.order.cancelled",
      "intercom.conversation.tagged",
      "gorgias.ticket.created",
      "klaviyo.event.received",
    ],
    actions: [
      "save_knowledge(Order)",
      "save_knowledge(RefundPattern)",
      "slack.post_message(#cx)",
      "gorgias.reply_ticket",
      "shopify.update_product",
    ],
  },
  market: {
    watcherName: "founder-activity-tracker",
    triggers: [
      "exa.article.published",
      "x.post.from_founder",
      "linkedin.update.posted",
      "github.commit.pushed",
      "crunchbase.funding.announced",
    ],
    actions: [
      "save_knowledge(Founder)",
      "save_knowledge(Signal)",
      "slack.post_message(#deals)",
      "notion.append_block(roster)",
      "gmail.send_draft(intro)",
    ],
  },
};

export function getWatcherShape(useCaseId: LandingUseCaseId): WatcherShape {
  return WATCHERS[useCaseId];
}

const ROW_HEIGHT = 28;
const ROW_GAP = 8;
const ROWS = 5;
const COL_TRIGGER_W = 220;
const COL_ACTION_W = 220;
const CENTER_W = 200;
const CENTER_H = 70;
const SVG_GAP = 56;
const SVG_W = COL_TRIGGER_W + SVG_GAP + CENTER_W + SVG_GAP + COL_ACTION_W;
const SVG_H = ROWS * (ROW_HEIGHT + ROW_GAP) - ROW_GAP;

export function WebhookFanDiagram(props: { useCaseId: LandingUseCaseId }) {
  const shape = WATCHERS[props.useCaseId];
  if (!shape) return null;

  const triggerYs = shape.triggers.map(
    (_, i) => i * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2
  );
  const actionYs = shape.actions.map(
    (_, i) => i * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2
  );

  const centerX = COL_TRIGGER_W + SVG_GAP + CENTER_W / 2;
  const centerY = SVG_H / 2;
  const triggerEdgeX = COL_TRIGGER_W;
  const centerLeftX = COL_TRIGGER_W + SVG_GAP;
  const centerRightX = centerLeftX + CENTER_W;
  const actionEdgeX = COL_TRIGGER_W + SVG_GAP + CENTER_W + SVG_GAP;

  const HIGHLIGHT_TRIGGER = 0;
  const HIGHLIGHT_ACTION = 2;

  return (
    <div
      class="overflow-hidden rounded-lg border bg-[var(--color-page-surface)]/70 p-4 sm:p-5"
      style={{ borderColor: "var(--color-page-border)" }}
    >
      <div class="mb-3 flex items-baseline justify-between font-mono text-[11px] uppercase tracking-[0.12em]" style={{ color: "var(--color-page-text-muted)" }}>
        <span style={{ color: "var(--color-tg-accent)" }}>Triggers</span>
        <span>worker.webhook</span>
        <span style={{ color: "var(--color-tg-accent)" }}>Actions</span>
      </div>
      <div class="overflow-x-auto">
        <svg
          width={SVG_W}
          height={SVG_H}
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          class="max-w-full"
          role="img"
          aria-label={`Fan diagram for ${shape.watcherName}`}
        >
          <title>{`Fan-in / fan-out for ${shape.watcherName}`}</title>
          {/* Connector lines */}
          {triggerYs.map((y, i) => (
            <line
              key={`tl-${i}`}
              x1={triggerEdgeX}
              y1={y}
              x2={centerLeftX}
              y2={centerY}
              stroke={
                i === HIGHLIGHT_TRIGGER
                  ? "var(--color-tg-accent)"
                  : "var(--color-page-border)"
              }
              stroke-width={i === HIGHLIGHT_TRIGGER ? 2 : 1}
              opacity={i === HIGHLIGHT_TRIGGER ? 0.9 : 0.45}
            />
          ))}
          {actionYs.map((y, i) => (
            <line
              key={`al-${i}`}
              x1={centerRightX}
              y1={centerY}
              x2={actionEdgeX}
              y2={y}
              stroke={
                i === HIGHLIGHT_ACTION
                  ? "var(--color-tg-accent)"
                  : "var(--color-page-border)"
              }
              stroke-width={i === HIGHLIGHT_ACTION ? 2 : 1}
              opacity={i === HIGHLIGHT_ACTION ? 0.9 : 0.45}
            />
          ))}

          {/* Trigger pills */}
          {shape.triggers.map((trigger, i) => (
            <g key={`t-${i}`} transform={`translate(0, ${i * (ROW_HEIGHT + ROW_GAP)})`}>
              <rect
                x={0}
                y={0}
                width={COL_TRIGGER_W}
                height={ROW_HEIGHT}
                rx={6}
                fill={
                  i === HIGHLIGHT_TRIGGER
                    ? "var(--color-landing-callout-bg)"
                    : "var(--color-page-bg)"
                }
                stroke="var(--color-page-border)"
                stroke-width={1}
              />
              <text
                x={12}
                y={ROW_HEIGHT / 2}
                dominant-baseline="middle"
                font-family="ui-monospace, monospace"
                font-size={11}
                fill="var(--color-page-text)"
              >
                {trigger}
              </text>
            </g>
          ))}

          {/* Center webhook box */}
          <g transform={`translate(${centerLeftX}, ${centerY - CENTER_H / 2})`}>
            <rect
              x={0}
              y={0}
              width={CENTER_W}
              height={CENTER_H}
              rx={10}
              fill="var(--color-page-bg)"
              stroke="var(--color-tg-accent)"
              stroke-width={2}
            />
            <text
              x={CENTER_W / 2}
              y={26}
              text-anchor="middle"
              font-family="ui-monospace, monospace"
              font-size={11}
              fill="var(--color-tg-accent)"
              font-weight={600}
            >
              worker.webhook(
            </text>
            <text
              x={CENTER_W / 2}
              y={44}
              text-anchor="middle"
              font-family="ui-monospace, monospace"
              font-size={12.5}
              fill="var(--color-page-text)"
            >
              {`"${shape.watcherName}"`}
            </text>
            <text
              x={CENTER_W / 2}
              y={60}
              text-anchor="middle"
              font-family="ui-monospace, monospace"
              font-size={11}
              fill="var(--color-tg-accent)"
              font-weight={600}
            >
              )
            </text>
          </g>

          {/* Action pills */}
          {shape.actions.map((action, i) => (
            <g key={`a-${i}`} transform={`translate(${actionEdgeX - COL_ACTION_W}, ${i * (ROW_HEIGHT + ROW_GAP)})`}>
              <rect
                x={0}
                y={0}
                width={COL_ACTION_W}
                height={ROW_HEIGHT}
                rx={6}
                fill={
                  i === HIGHLIGHT_ACTION
                    ? "var(--color-landing-callout-bg)"
                    : "var(--color-page-bg)"
                }
                stroke="var(--color-page-border)"
                stroke-width={1}
              />
              <text
                x={12}
                y={ROW_HEIGHT / 2}
                dominant-baseline="middle"
                font-family="ui-monospace, monospace"
                font-size={11}
                fill="var(--color-page-text)"
              >
                {action}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <p class="mt-3 text-[12.5px]" style={{ color: "var(--color-page-text-muted)" }}>
        Highlighted path: any matching trigger event fans into the watcher
        webhook, which extracts schema-typed data, persists it as memory, and
        fans the structured output back out to your team's actions.
      </p>
    </div>
  );
}
