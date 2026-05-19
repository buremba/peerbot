import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

type Txn = { Id: string; TxnDate: string; Amount: number; AccountRef?: { name?: string }; EntityRef?: { name?: string } };

export default class QuickBooksTransactionsConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "quickbooks-transactions",
    name: "QuickBooks transactions",
    description: "Streams new bank-feed transactions out of QuickBooks Online.",
    version: "1.0.0",
    authSchema: { methods: [{ type: "oauth", provider: "intuit" }] },
    feeds: { transactions: { key: "transactions", name: "Posted transactions" } },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const since =
      (ctx.checkpoint as { last_txn_date?: string } | null)?.last_txn_date ??
      "1970-01-01";
    const q = `SELECT * FROM Transaction WHERE TxnDate > '${since}' ORDERBY TxnDate ASC MAXRESULTS 500`;
    const url = `https://quickbooks.api.intuit.com/v3/company/${ctx.config.realm_id}/query?query=${encodeURIComponent(q)}`;
    const body = (await (await fetch(url)).json()) as { QueryResponse?: { Transaction?: Txn[] } };
    const txns = body.QueryResponse?.Transaction ?? [];
    return {
      events: txns.map((t) => ({
        origin_id: t.Id,
        origin_type: "transaction_posted",
        title: `${t.AccountRef?.name ?? "Bank"} — $${t.Amount.toFixed(2)}`,
        occurred_at: new Date(`${t.TxnDate}T00:00:00Z`),
        metadata: { amount: t.Amount, payee: t.EntityRef?.name },
      })),
      checkpoint: { last_txn_date: txns.at(-1)?.TxnDate ?? since } as unknown as Record<string, unknown>,
    };
  }
}
