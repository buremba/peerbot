/**
 * QuickBooks-transactions connector — pulls newly posted bank-feed
 * transactions from QuickBooks Online and emits one event per line item.
 * The `finance` agent uses these to populate Transaction entities and to
 * drive its reconciliation watcher.
 *
 * Auth: OAuth (Intuit). The realm id (the tenant company id) is part of the
 * connection config and threaded through every request.
 */

import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

interface QboConfig {
  realm_id: string;
  account_id?: string;
}

interface QboCheckpoint {
  last_txn_date: string;
}

interface QboTransaction {
  Id: string;
  TxnDate: string;
  Amount: number;
  PaymentType?: string;
  CheckNum?: string;
  Memo?: string;
  AccountRef?: { value: string; name: string };
  EntityRef?: { value: string; name: string };
}

const PAGE_SIZE = 500;

export default class QuickBooksTransactionsConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "quickbooks-transactions",
    name: "QuickBooks transactions",
    description:
      "Streams new bank-feed transactions out of QuickBooks Online.",
    version: "1.0.0",
    authSchema: { methods: [{ type: "oauth", provider: "intuit" }] },
    feeds: {
      transactions: {
        key: "transactions",
        name: "Posted transactions",
        description:
          "Bank-feed entries posted to QBO since the last cursor date.",
        configSchema: {
          type: "object",
          required: ["realm_id"],
          properties: {
            realm_id: { type: "string" },
            account_id: { type: "string" },
          },
        },
        eventKinds: {
          transaction_posted: {
            description: "A new transaction was posted to QBO.",
            metadataSchema: {
              type: "object",
              properties: {
                amount: { type: "number" },
                account: { type: "string" },
                payee: { type: "string" },
              },
            },
          },
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as unknown as QboConfig;
    if (!config?.realm_id) {
      throw new Error("quickbooks-transactions: `realm_id` is required");
    }

    const checkpoint = (ctx.checkpoint as QboCheckpoint | null) ?? {
      last_txn_date: "1970-01-01",
    };
    const query = this.buildQuery(checkpoint.last_txn_date, config.account_id);
    const url = `https://quickbooks.api.intuit.com/v3/company/${config.realm_id}/query?query=${encodeURIComponent(query)}`;

    const transactions = await this.fetchTransactions(url);
    const events: EventEnvelope[] = transactions.map((txn) => ({
      origin_id: txn.Id,
      origin_type: "transaction_posted",
      title: `${txn.AccountRef?.name ?? "Bank"} — $${txn.Amount.toFixed(2)}`,
      payload_text: txn.Memo ?? `Posted to ${txn.AccountRef?.name ?? "?"}`,
      occurred_at: new Date(`${txn.TxnDate}T00:00:00Z`),
      metadata: {
        amount: txn.Amount,
        account: txn.AccountRef?.name,
        payee: txn.EntityRef?.name,
      },
    }));

    const nextCursor =
      transactions.length === 0
        ? checkpoint.last_txn_date
        : transactions[transactions.length - 1].TxnDate;

    return {
      events,
      checkpoint: { last_txn_date: nextCursor } as unknown as Record<
        string,
        unknown
      >,
      metadata: { items_found: events.length },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: "Actions not supported" };
  }

  private buildQuery(since: string, accountId?: string): string {
    const accountFilter = accountId ? ` AND AccountRef = '${accountId}'` : "";
    return `SELECT * FROM Transaction WHERE TxnDate > '${since}'${accountFilter} ORDERBY TxnDate ASC MAXRESULTS ${PAGE_SIZE}`;
  }

  private async fetchTransactions(url: string): Promise<QboTransaction[]> {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`QBO ${response.status}: ${response.statusText}`);
    }
    const body = (await response.json()) as {
      QueryResponse?: { Transaction?: QboTransaction[] };
    };
    return body.QueryResponse?.Transaction ?? [];
  }
}
