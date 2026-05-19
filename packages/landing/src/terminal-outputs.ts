/**
 * Per-use-case, per-primitive-section terminal outputs rendered by
 * <TerminalPanel>. These are FAKED transcripts that suggest what the
 * primitive looks like when it runs — chosen to match the connector key,
 * entity slug, watcher name, and agent id the snippet panel on the left is
 * showing.
 *
 * Each entry has a title (the dot-titlebar caption) and a list of lines,
 * where each line is a tagged segment list consumed by TerminalPanel.
 */

import type { LandingUseCaseId } from "./use-case-definitions";
import type { TerminalLine } from "./components/TerminalPanel";

export type TerminalSectionKey =
  | "connectors"
  | "memory"
  | "watchers"
  | "agents";

export type TerminalOutput = { title: string; lines: TerminalLine[] };

/** Tiny tagged-template helpers so the data block reads compactly. */
const p = (text: string): TerminalLine[][number][0] => ({ text });
const muted = (text: string): TerminalLine[][number][0] => ({
  text,
  kind: "muted",
});
const accent = (text: string): TerminalLine[][number][0] => ({
  text,
  kind: "accent",
});
const str = (text: string): TerminalLine[][number][0] => ({
  text,
  kind: "string",
});
const key = (text: string): TerminalLine[][number][0] => ({
  text,
  kind: "key",
});
const ok = (text = "✓"): TerminalLine[][number][0] => ({ text, kind: "green" });

const ARROW = muted("→ ");
const DOLLAR = muted("$ ");

/** Quick line constructor. */
const line = (...segs: TerminalLine[][number]): TerminalLine => segs;

type PerSection = Record<TerminalSectionKey, TerminalOutput>;

/* -------------------------------------------------------------------------- */

const sales: PerSection = {
  connectors: {
    title: "lobu run · sales",
    lines: [
      line(DOLLAR, p("lobu run")),
      line(ARROW, p("connector  "), key("salesforce-pipeline   "), ok()),
      line(
        ARROW,
        p("synced     "),
        str("3 opportunities       "),
        muted("142 ms")
      ),
      line(
        ARROW,
        p("event      "),
        key("salesforce.opp.updated"),
        p(" "),
        str("#acme-q4")
      ),
      line(
        ARROW,
        p("event      "),
        key("salesforce.opp.updated"),
        p(" "),
        str("#wisdom-q1")
      ),
    ],
  },
  memory: {
    title: "lobu memory · sales",
    lines: [
      line(DOLLAR, p("lobu memory save_knowledge --entity Organization")),
      line(ARROW, p("entity     "), key("Organization "), str("#acme")),
      line(
        ARROW,
        p("fields     "),
        p("stage="),
        str("pilot"),
        p(" arr="),
        str("$120k")
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("8 ms")
      ),
    ],
  },
  watchers: {
    title: "lobu watch · sales",
    lines: [
      line(DOLLAR, p("lobu watch")),
      line(
        ARROW,
        p("trigger    "),
        key("salesforce.opp.updated"),
        p(" "),
        str("#acme-q4")
      ),
      line(
        ARROW,
        p("watcher    "),
        key("account-health-monitor"),
        p("  "),
        accent("running")
      ),
      line(
        ARROW,
        p("extracted  "),
        p("risk_level="),
        str("warm"),
        p(" first_action="),
        str('"ping CSM"')
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("312 ms")
      ),
    ],
  },
  agents: {
    title: "lobu chat -a sales",
    lines: [
      line(DOLLAR, p("lobu chat -a sales")),
      line(accent("> "), p("how's acme looking?")),
      line(ARROW, p("recalled   "), str("3 Organization, 2 Product")),
      line(
        ARROW,
        p("reply      "),
        p("Acme is in pilot ($120k ARR), renewal in 41 days…")
      ),
    ],
  },
};

const finance: PerSection = {
  connectors: {
    title: "lobu run · finance",
    lines: [
      line(DOLLAR, p("lobu run")),
      line(
        ARROW,
        p("connector  "),
        key("quickbooks-transactions"),
        p("  "),
        ok()
      ),
      line(
        ARROW,
        p("synced     "),
        str("18 transactions       "),
        muted("96 ms")
      ),
      line(
        ARROW,
        p("event      "),
        key("transaction_posted    "),
        str("$2,140.00 AWS")
      ),
      line(
        ARROW,
        p("event      "),
        key("transaction_posted    "),
        str("$890.00 Datadog")
      ),
    ],
  },
  memory: {
    title: "lobu memory · finance",
    lines: [
      line(DOLLAR, p("lobu memory save_knowledge --entity Transaction")),
      line(ARROW, p("entity     "), key("Transaction "), str("#txn-9817")),
      line(
        ARROW,
        p("fields     "),
        p("amount="),
        str("$2,140.00"),
        p(" payee="),
        str("AWS")
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("11 ms")
      ),
    ],
  },
  watchers: {
    title: "lobu watch · finance",
    lines: [
      line(DOLLAR, p("lobu watch")),
      line(
        ARROW,
        p("trigger    "),
        key("transaction_posted    "),
        str("#txn-9817")
      ),
      line(
        ARROW,
        p("watcher    "),
        key("reconciliation-monitor"),
        p("  "),
        accent("running")
      ),
      line(
        ARROW,
        p("extracted  "),
        p("status="),
        str("unmatched"),
        p(" suggested_invoice="),
        str("INV-2204")
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("286 ms")
      ),
    ],
  },
  agents: {
    title: "lobu chat -a finance",
    lines: [
      line(DOLLAR, p("lobu chat -a finance")),
      line(accent("> "), p("what's outstanding for october?")),
      line(ARROW, p("recalled   "), str("12 Transaction, 4 Invoice")),
      line(
        ARROW,
        p("reply      "),
        p("$8,310 unreconciled across 4 vendors. Top: AWS $2,140.")
      ),
    ],
  },
};

const legal: PerSection = {
  connectors: {
    title: "lobu run · legal",
    lines: [
      line(DOLLAR, p("lobu run")),
      line(ARROW, p("connector  "), key("docusign-envelopes    "), ok()),
      line(
        ARROW,
        p("synced     "),
        str("4 envelopes           "),
        muted("88 ms")
      ),
      line(
        ARROW,
        p("event      "),
        key("envelope_status       "),
        str("MSA-2024 → completed")
      ),
      line(
        ARROW,
        p("event      "),
        key("envelope_status       "),
        str("NDA-Wisdom → sent")
      ),
    ],
  },
  memory: {
    title: "lobu memory · legal",
    lines: [
      line(DOLLAR, p("lobu memory save_knowledge --entity Contract")),
      line(ARROW, p("entity     "), key("Contract    "), str("#msa-2024")),
      line(
        ARROW,
        p("fields     "),
        p("status="),
        str("active"),
        p(" counterparty="),
        str("Acme Inc")
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("9 ms")
      ),
    ],
  },
  watchers: {
    title: "lobu watch · legal",
    lines: [
      line(DOLLAR, p("lobu watch")),
      line(
        ARROW,
        p("trigger    "),
        key("envelope_status       "),
        str("MSA-2024 → completed")
      ),
      line(
        ARROW,
        p("watcher    "),
        key("contract-clause-review"),
        p("  "),
        accent("running")
      ),
      line(
        ARROW,
        p("extracted  "),
        p("missing_clauses=["),
        str("indemnity, sla"),
        p("] risk="),
        str("medium")
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("412 ms")
      ),
    ],
  },
  agents: {
    title: "lobu chat -a legal",
    lines: [
      line(DOLLAR, p("lobu chat -a legal")),
      line(accent("> "), p("any contracts at risk this quarter?")),
      line(ARROW, p("recalled   "), str("9 Contract, 14 Clause")),
      line(
        ARROW,
        p("reply      "),
        p("MSA-2024 missing indemnity + SLA; NDA-Wisdom awaiting sign.")
      ),
    ],
  },
};

const delivery: PerSection = {
  connectors: {
    title: "lobu run · delivery",
    lines: [
      line(DOLLAR, p("lobu run")),
      line(ARROW, p("connector  "), key("shopify-orders        "), ok()),
      line(
        ARROW,
        p("synced     "),
        str("11 orders             "),
        muted("104 ms")
      ),
      line(
        ARROW,
        p("event      "),
        key("order_updated         "),
        str("#1042 → fulfilled")
      ),
      line(
        ARROW,
        p("event      "),
        key("order_updated         "),
        str("#1043 → partial")
      ),
    ],
  },
  memory: {
    title: "lobu memory · delivery",
    lines: [
      line(DOLLAR, p("lobu memory save_knowledge --entity Shipment")),
      line(ARROW, p("entity     "), key("Shipment    "), str("#sh-1042")),
      line(
        ARROW,
        p("fields     "),
        p("carrier="),
        str("FedEx"),
        p(" eta="),
        str("Nov 19")
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("12 ms")
      ),
    ],
  },
  watchers: {
    title: "lobu watch · delivery",
    lines: [
      line(DOLLAR, p("lobu watch")),
      line(
        ARROW,
        p("trigger    "),
        key("order_updated         "),
        str("#1042 → fulfilled")
      ),
      line(
        ARROW,
        p("watcher    "),
        key("at-risk-shipment      "),
        accent("running")
      ),
      line(
        ARROW,
        p("extracted  "),
        p("risk="),
        str("low"),
        p(" reason="),
        str('"on-time carrier scan"')
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("224 ms")
      ),
    ],
  },
  agents: {
    title: "lobu chat -a delivery",
    lines: [
      line(DOLLAR, p("lobu chat -a delivery")),
      line(accent("> "), p("anything late this week?")),
      line(ARROW, p("recalled   "), str("11 Shipment, 2 Incident")),
      line(
        ARROW,
        p("reply      "),
        p("2 shipments delayed: #1043 (FedEx), #1029 (UPS). ETAs slipped 36h.")
      ),
    ],
  },
};

const leadership: PerSection = {
  connectors: {
    title: "lobu run · leadership",
    lines: [
      line(DOLLAR, p("lobu run")),
      line(ARROW, p("connector  "), key("linear-cycles         "), ok()),
      line(
        ARROW,
        p("synced     "),
        str("23 issues             "),
        muted("178 ms")
      ),
      line(
        ARROW,
        p("event      "),
        key("issue_state_changed   "),
        str("ENG-441 → done")
      ),
      line(
        ARROW,
        p("event      "),
        key("issue_state_changed   "),
        str("ENG-447 → blocked")
      ),
    ],
  },
  memory: {
    title: "lobu memory · leadership",
    lines: [
      line(DOLLAR, p("lobu memory save_knowledge --entity Initiative")),
      line(
        ARROW,
        p("entity     "),
        key("Initiative  "),
        str("#ai-platform-q4")
      ),
      line(
        ARROW,
        p("fields     "),
        p("status="),
        str("on-track"),
        p(" owner="),
        str("@maria")
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("10 ms")
      ),
    ],
  },
  watchers: {
    title: "lobu watch · leadership",
    lines: [
      line(DOLLAR, p("lobu watch")),
      line(
        ARROW,
        p("trigger    "),
        key("cron @ 09:00          "),
        str("monday")
      ),
      line(
        ARROW,
        p("watcher    "),
        key("weekly-execution-digest"),
        p(" "),
        accent("running")
      ),
      line(
        ARROW,
        p("extracted  "),
        p("shipped="),
        str("18"),
        p(" blockers="),
        str("2"),
        p(" decisions="),
        str("3")
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("1.4 s")
      ),
    ],
  },
  agents: {
    title: "lobu chat -a leadership",
    lines: [
      line(DOLLAR, p("lobu chat -a leadership")),
      line(accent("> "), p("how's q4 platform looking?")),
      line(ARROW, p("recalled   "), str("3 Initiative, 23 Issue")),
      line(
        ARROW,
        p("reply      "),
        p(
          "AI Platform on track (18 shipped). Risk: ENG-447 blocked 4d on Stripe."
        )
      ),
    ],
  },
};

const agentCommunity: PerSection = {
  connectors: {
    title: "lobu run · agent-community",
    lines: [
      line(DOLLAR, p("lobu run")),
      line(ARROW, p("connector  "), key("discourse-posts       "), ok()),
      line(
        ARROW,
        p("synced     "),
        str("7 posts               "),
        muted("76 ms")
      ),
      line(
        ARROW,
        p("event      "),
        key("post_created          "),
        str('"How does memory scale?"')
      ),
      line(
        ARROW,
        p("event      "),
        key("post_created          "),
        str('"OpenClaw + Linear walkthrough"')
      ),
    ],
  },
  memory: {
    title: "lobu memory · agent-community",
    lines: [
      line(DOLLAR, p("lobu memory save_knowledge --entity Member")),
      line(ARROW, p("entity     "), key("Member      "), str("#anya")),
      line(
        ARROW,
        p("fields     "),
        p("focus="),
        str("evals"),
        p(" karma="),
        str("248")
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("9 ms")
      ),
    ],
  },
  watchers: {
    title: "lobu watch · agent-community",
    lines: [
      line(DOLLAR, p("lobu watch")),
      line(
        ARROW,
        p("trigger    "),
        key("post_created          "),
        str('"OpenClaw + Linear"')
      ),
      line(
        ARROW,
        p("watcher    "),
        key("opportunity-matcher   "),
        accent("running")
      ),
      line(
        ARROW,
        p("extracted  "),
        p("match="),
        str("@anya"),
        p(" reason="),
        str('"writes evals"')
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("289 ms")
      ),
    ],
  },
  agents: {
    title: "lobu chat -a agent-community",
    lines: [
      line(DOLLAR, p("lobu chat -a agent-community")),
      line(
        accent("> "),
        p("who should I intro to the Linear walkthrough thread?")
      ),
      line(ARROW, p("recalled   "), str("48 Member, 12 Opportunity")),
      line(
        ARROW,
        p("reply      "),
        p("@anya, @lior — both shipped Linear MCP demos last week.")
      ),
    ],
  },
};

const ecommerce: PerSection = {
  connectors: {
    title: "lobu run · ecommerce",
    lines: [
      line(DOLLAR, p("lobu run")),
      line(ARROW, p("connector  "), key("stripe-charges        "), ok()),
      line(
        ARROW,
        p("synced     "),
        str("32 charges            "),
        muted("118 ms")
      ),
      line(
        ARROW,
        p("event      "),
        key("charge_succeeded      "),
        str("$49.00 USD #anna")
      ),
      line(
        ARROW,
        p("event      "),
        key("charge_refunded       "),
        str("$129.00 USD #luca")
      ),
    ],
  },
  memory: {
    title: "lobu memory · ecommerce",
    lines: [
      line(DOLLAR, p("lobu memory save_knowledge --entity Customer")),
      line(ARROW, p("entity     "), key("Customer    "), str("#anna")),
      line(
        ARROW,
        p("fields     "),
        p("plan="),
        str("pro"),
        p(" status="),
        str("active")
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("7 ms")
      ),
    ],
  },
  watchers: {
    title: "lobu watch · ecommerce",
    lines: [
      line(DOLLAR, p("lobu watch")),
      line(
        ARROW,
        p("trigger    "),
        key("charge_refunded       "),
        str("#luca")
      ),
      line(
        ARROW,
        p("watcher    "),
        key("refund-pattern-detector"),
        p(" "),
        accent("running")
      ),
      line(
        ARROW,
        p("extracted  "),
        p("pattern="),
        str('"new-sku-friction"'),
        p(" confidence="),
        str("0.82")
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("351 ms")
      ),
    ],
  },
  agents: {
    title: "lobu chat -a ecommerce",
    lines: [
      line(DOLLAR, p("lobu chat -a ecommerce")),
      line(accent("> "), p("what's driving refunds this week?")),
      line(ARROW, p("recalled   "), str("32 Order, 7 RefundPattern")),
      line(
        ARROW,
        p("reply      "),
        p('New SKU "travel-mug" has 11% refund rate; sizing complaints x4.')
      ),
    ],
  },
};

const market: PerSection = {
  connectors: {
    title: "lobu run · market",
    lines: [
      line(DOLLAR, p("lobu run")),
      line(ARROW, p("connector  "), key("exa-news-feed         "), ok()),
      line(
        ARROW,
        p("synced     "),
        str("9 articles            "),
        muted("220 ms")
      ),
      line(
        ARROW,
        p("event      "),
        key("article_published     "),
        str('"Tigris raises $14M Series A"')
      ),
      line(
        ARROW,
        p("event      "),
        key("article_published     "),
        str('"Wisdom AI eyes Asia expansion"')
      ),
    ],
  },
  memory: {
    title: "lobu memory · market",
    lines: [
      line(DOLLAR, p("lobu memory save_knowledge --entity Founder")),
      line(ARROW, p("entity     "), key("Founder     "), str("#anu-tigris")),
      line(
        ARROW,
        p("fields     "),
        p("company="),
        str("Tigris"),
        p(" theme="),
        str('"storage infra"')
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("11 ms")
      ),
    ],
  },
  watchers: {
    title: "lobu watch · market",
    lines: [
      line(DOLLAR, p("lobu watch")),
      line(
        ARROW,
        p("trigger    "),
        key("article_published     "),
        str('"Tigris raises $14M"')
      ),
      line(
        ARROW,
        p("watcher    "),
        key("founder-activity-tracker"),
        accent(" running")
      ),
      line(
        ARROW,
        p("extracted  "),
        p("activity_level="),
        str("high"),
        p(" sentiment="),
        str("bullish")
      ),
      line(
        ARROW,
        p("event      "),
        key("knowledge.created     "),
        muted("488 ms")
      ),
    ],
  },
  agents: {
    title: "lobu chat -a market",
    lines: [
      line(DOLLAR, p("lobu chat -a market")),
      line(accent("> "), p("anything new from the storage-infra space?")),
      line(ARROW, p("recalled   "), str("3 Founder, 5 Signal")),
      line(
        ARROW,
        p("reply      "),
        p(
          "Tigris ($14M Series A, Lightspeed); Anu posted 3x about disagg storage."
        )
      ),
    ],
  },
};

export const TERMINAL_OUTPUTS: Record<LandingUseCaseId, PerSection> = {
  sales,
  finance,
  legal,
  delivery,
  leadership,
  "agent-community": agentCommunity,
  ecommerce,
  market,
};
