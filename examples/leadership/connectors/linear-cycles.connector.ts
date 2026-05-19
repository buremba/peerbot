import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

type Issue = { id: string; identifier: string; title: string; url: string; updatedAt: string; state: { name: string }; assignee?: { name: string } };

const QUERY = `query Cycle($t:ID!,$a:DateTimeOrDuration!){issues(first:100,filter:{team:{id:{eq:$t}},updatedAt:{gt:$a},cycle:{isActive:{eq:true}}},orderBy:updatedAt){nodes{id identifier title url updatedAt state{name} assignee{name}}}}`;

export default class LinearCyclesConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "linear-cycles",
    name: "Linear cycles",
    description: "Tracks issue transitions inside the active Linear cycle.",
    version: "1.0.0",
    authSchema: { methods: [{ type: "oauth", provider: "linear" }] },
    feeds: { cycle_issues: { key: "cycle_issues", name: "Cycle issues" } },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const since =
      (ctx.checkpoint as { updated_at?: string } | null)?.updated_at ??
      "2000-01-01T00:00:00Z";
    const r = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { t: ctx.config.team_id, a: since } }),
    });
    const body = (await r.json()) as { data?: { issues?: { nodes?: Issue[] } } };
    const issues = body.data?.issues?.nodes ?? [];
    return {
      events: issues.map((i) => ({
        origin_id: `${i.id}:${i.state.name}:${i.updatedAt}`,
        origin_type: "issue_state_changed",
        title: `${i.identifier} ${i.title} → ${i.state.name}`,
        author_name: i.assignee?.name,
        source_url: i.url,
        occurred_at: new Date(i.updatedAt),
      })),
      checkpoint: { updated_at: issues.at(-1)?.updatedAt ?? since } as unknown as Record<string, unknown>,
    };
  }
}
