import { ConnectorRuntime, type SyncContext } from "@lobu/connector-sdk";

export default class QuickBooksTransactionsConnector extends ConnectorRuntime {
  readonly definition = {
    key: "quickbooks-transactions",
    name: "QuickBooks transactions",
    version: "1.0.0",
    authSchema: { methods: [{ type: "oauth" as const, provider: "intuit" }] },
    feeds: { transactions: { key: "transactions", name: "Posted transactions" } },
  };

  async sync(ctx: SyncContext) {
    const since = (ctx.checkpoint as { last_txn_date?: string } | null)?.last_txn_date ?? "1970-01-01";
    const q = `SELECT * FROM Transaction WHERE TxnDate > '${since}' ORDERBY TxnDate ASC MAXRESULTS 500`;
    const r = await fetch(`https://quickbooks.api.intuit.com/v3/company/${ctx.config.realm_id}/query?query=${encodeURIComponent(q)}`);
    const body = (await r.json()) as { QueryResponse?: { Transaction?: Array<{ Id: string; TxnDate: string; Amount: number; AccountRef?: { name?: string } }> } };
    const txns = body.QueryResponse?.Transaction ?? [];
    return {
      events: txns.map((t) => ({
        origin_id: t.Id,
        origin_type: "transaction_posted",
        title: `${t.AccountRef?.name ?? "Bank"} — $${t.Amount.toFixed(2)}`,
        occurred_at: new Date(`${t.TxnDate}T00:00:00Z`),
      })),
      checkpoint: { last_txn_date: txns.at(-1)?.TxnDate ?? since } as Record<string, unknown>,
    };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
