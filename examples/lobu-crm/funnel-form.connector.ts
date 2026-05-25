import {
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

interface FunnelCheckpoint {
  seen_ids: string[];
}

interface FunnelConfig {
  endpoint: string;
}

/**
 * Funnel-form connector — polls a small JSON API (`config.endpoint` returns
 * `{ submissions: [...] }`) and emits one event per new submission. Dedup
 * via a rolling checkpoint of seen IDs. Auto-discovered by `lobu apply`.
 *
 * Demonstrates: ConnectorRuntime<C, F> with typed checkpoint + config.
 */
export default class FunnelFormConnector extends ConnectorRuntime<
  FunnelCheckpoint,
  FunnelConfig
> {
  readonly definition = {
    key: "funnel-form",
    name: "Funnel form",
    version: "1.0.0",
    authSchema: { methods: [{ type: "none" as const }] },
    feeds: { submissions: { key: "submissions", name: "Form submissions" } },
  };

  async sync(
    ctx: SyncContext<FunnelCheckpoint, FunnelConfig>
  ): Promise<SyncResult<FunnelCheckpoint>> {
    const seen = new Set<string>(ctx.checkpoint?.seen_ids ?? []);
    const subs: any[] =
      (await (await fetch(ctx.config.endpoint)).json()).submissions ?? [];
    const fresh = subs.filter((s) => s?.id && !seen.has(s.id));
    return {
      events: fresh.map((s) => ({
        origin_id: s.id,
        origin_type: "form_submission",
        title: s.company
          ? `Demo request — ${s.company}`
          : `Demo request — ${s.name ?? s.email ?? s.id}`,
        payload_text: s.message ?? "",
        author_name: s.name,
        occurred_at: s.submitted_at ? new Date(s.submitted_at) : new Date(),
        metadata: { company: s.company, email: s.email },
      })),
      checkpoint: {
        seen_ids: [...seen, ...fresh.map((s) => s.id)].slice(-1000),
      },
    };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
