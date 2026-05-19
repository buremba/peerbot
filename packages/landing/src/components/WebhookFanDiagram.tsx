import type { LandingUseCaseId } from "../use-case-definitions";

/**
 * Flat fan-in / fan-out visualisation for the Watchers section.
 *
 * Three columns, all the same visual weight (no shadows, no gradients):
 *   left   — trigger event types
 *   center — one rounded box with the watcher's webhook call
 *   right  — actions / reaction targets
 *
 * Connector lines are thin SVG drawn behind the columns; one trigger and one
 * action are highlighted to show a representative hot path.
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

/* Layout constants — kept small and local so the SVG sizes match the
   surrounding flex grid exactly. */
const ROW_HEIGHT = 26;
const ROW_GAP = 8;
const COL_W = 220;
const CENTER_W = 200;
const CENTER_H = 60;
const SVG_GAP = 56;
const SVG_W = COL_W + SVG_GAP + CENTER_W + SVG_GAP + COL_W;

const HIGHLIGHT_TRIGGER = 0;
const HIGHLIGHT_ACTION = 2;

export function WebhookFanDiagram(props: { useCaseId: LandingUseCaseId }) {
  const shape = WATCHERS[props.useCaseId];
  if (!shape) return null;

  const rows = Math.max(shape.triggers.length, shape.actions.length);
  const svgH = rows * (ROW_HEIGHT + ROW_GAP) - ROW_GAP;
  const triggerYs = shape.triggers.map(
    (_, i) => i * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2
  );
  const actionYs = shape.actions.map(
    (_, i) => i * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2
  );
  const centerY = svgH / 2;
  const triggerEdgeX = COL_W;
  const centerLeftX = COL_W + SVG_GAP;
  const centerRightX = centerLeftX + CENTER_W;
  const actionEdgeX = centerRightX + SVG_GAP;

  return (
    <div
      class="rounded-lg border p-5"
      style={{
        borderColor: "var(--color-page-border)",
        backgroundColor: "var(--color-page-surface)",
      }}
    >
      <div
        class="mb-4 grid grid-cols-3 items-baseline font-mono text-[10.5px] uppercase tracking-[0.12em]"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        <span>triggers</span>
        <span class="text-center">worker.webhook</span>
        <span class="text-right">actions</span>
      </div>
      <div class="overflow-x-auto">
        <svg
          width={SVG_W}
          height={svgH}
          viewBox={`0 0 ${SVG_W} ${svgH}`}
          class="block max-w-full"
          role="img"
          aria-label={`Fan diagram for ${shape.watcherName}`}
        >
          <title>{`Fan-in / fan-out for ${shape.watcherName}`}</title>
          {/* Connector lines (drawn first so labels overlap them) */}
          {triggerYs.map((y, i) => (
            <line
              key={`tl-${i}`}
              x1={triggerEdgeX}
              y1={y}
              x2={centerLeftX}
              y2={centerY}
              stroke={
                i === HIGHLIGHT_TRIGGER
                  ? "var(--color-page-text)"
                  : "var(--color-page-border)"
              }
              stroke-width={1}
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
                  ? "var(--color-page-text)"
                  : "var(--color-page-border)"
              }
              stroke-width={1}
            />
          ))}

          {/* Trigger rows */}
          {shape.triggers.map((trigger, i) => (
            <g
              key={`t-${i}`}
              transform={`translate(0, ${i * (ROW_HEIGHT + ROW_GAP)})`}
            >
              <rect
                x={0}
                y={0}
                width={COL_W}
                height={ROW_HEIGHT}
                rx={4}
                fill="var(--color-page-bg)"
                stroke={
                  i === HIGHLIGHT_TRIGGER
                    ? "var(--color-page-text)"
                    : "var(--color-page-border)"
                }
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
          <g
            transform={`translate(${centerLeftX}, ${centerY - CENTER_H / 2})`}
          >
            <rect
              x={0}
              y={0}
              width={CENTER_W}
              height={CENTER_H}
              rx={6}
              fill="var(--color-page-bg)"
              stroke="var(--color-page-text)"
              stroke-width={1}
            />
            <text
              x={CENTER_W / 2}
              y={22}
              text-anchor="middle"
              font-family="ui-monospace, monospace"
              font-size={11}
              fill="var(--color-page-text-muted)"
            >
              worker.webhook(
            </text>
            <text
              x={CENTER_W / 2}
              y={40}
              text-anchor="middle"
              font-family="ui-monospace, monospace"
              font-size={12}
              fill="var(--color-page-text)"
            >
              {`"${shape.watcherName}"`}
            </text>
            <text
              x={CENTER_W / 2}
              y={54}
              text-anchor="middle"
              font-family="ui-monospace, monospace"
              font-size={11}
              fill="var(--color-page-text-muted)"
            >
              )
            </text>
          </g>

          {/* Action rows */}
          {shape.actions.map((action, i) => (
            <g
              key={`a-${i}`}
              transform={`translate(${actionEdgeX}, ${i * (ROW_HEIGHT + ROW_GAP)})`}
            >
              <rect
                x={0}
                y={0}
                width={COL_W}
                height={ROW_HEIGHT}
                rx={4}
                fill="var(--color-page-bg)"
                stroke={
                  i === HIGHLIGHT_ACTION
                    ? "var(--color-page-text)"
                    : "var(--color-page-border)"
                }
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
    </div>
  );
}
