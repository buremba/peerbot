/**
 * Linear-cycles connector — polls Linear GraphQL for issues whose state
 * changed during the active cycle and emits one event per transition. The
 * `leadership` agent uses these to keep its Cycle and Initiative entities
 * in sync with engineering execution and to drive its nightly digest
 * dreaming watcher.
 *
 * Auth: Linear OAuth.
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

interface LinearConfig {
  team_id: string;
}

interface LinearCheckpoint {
  updated_at: string;
}

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  updatedAt: string;
  state: { name: string; type: string };
  cycle?: { id: string; name?: string; number?: number };
  assignee?: { name: string };
}

const PAGE_SIZE = 100;
const ENDPOINT = "https://api.linear.app/graphql";

export default class LinearCyclesConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "linear-cycles",
    name: "Linear cycles",
    description:
      "Tracks issue state transitions inside the active Linear cycle for a team.",
    version: "1.0.0",
    authSchema: { methods: [{ type: "oauth", provider: "linear" }] },
    feeds: {
      cycle_issues: {
        key: "cycle_issues",
        name: "Cycle issue transitions",
        description:
          "Issues in the team's active cycle whose state changed since the last cursor.",
        configSchema: {
          type: "object",
          required: ["team_id"],
          properties: {
            team_id: { type: "string" },
          },
        },
        eventKinds: {
          issue_state_changed: {
            description: "A Linear issue moved to a new workflow state.",
            metadataSchema: {
              type: "object",
              properties: {
                state: { type: "string" },
                cycle_number: { type: "integer" },
                assignee: { type: "string" },
              },
            },
          },
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as unknown as LinearConfig;
    if (!config?.team_id) {
      throw new Error("linear-cycles: `team_id` is required");
    }

    const checkpoint = (ctx.checkpoint as LinearCheckpoint | null) ?? {
      updated_at: "2000-01-01T00:00:00Z",
    };

    const issues = await this.fetchIssues(config.team_id, checkpoint.updated_at);
    const events: EventEnvelope[] = issues.map((issue) => ({
      origin_id: `${issue.id}:${issue.state.name}:${issue.updatedAt}`,
      origin_type: "issue_state_changed",
      title: `${issue.identifier} ${issue.title} → ${issue.state.name}`,
      author_name: issue.assignee?.name,
      source_url: issue.url,
      occurred_at: new Date(issue.updatedAt),
      metadata: {
        state: issue.state.name,
        cycle_number: issue.cycle?.number,
        assignee: issue.assignee?.name,
      },
    }));

    const nextCursor =
      issues.length === 0
        ? checkpoint.updated_at
        : issues[issues.length - 1].updatedAt;

    return {
      events,
      checkpoint: { updated_at: nextCursor } as unknown as Record<
        string,
        unknown
      >,
      metadata: { items_found: events.length },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: "Actions not supported" };
  }

  private async fetchIssues(
    teamId: string,
    updatedAfter: string
  ): Promise<LinearIssue[]> {
    const query = `query Cycle($teamId: ID!, $after: DateTimeOrDuration!, $first: Int!) {
      issues(
        first: $first,
        filter: { team: { id: { eq: $teamId } }, updatedAt: { gt: $after }, cycle: { isActive: { eq: true } } },
        orderBy: updatedAt
      ) {
        nodes {
          id identifier title url updatedAt
          state { name type }
          cycle { id name number }
          assignee { name }
        }
      }
    }`;
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { teamId, after: updatedAfter, first: PAGE_SIZE },
      }),
    });
    if (!response.ok) {
      throw new Error(`Linear ${response.status}: ${response.statusText}`);
    }
    const body = (await response.json()) as {
      data?: { issues?: { nodes?: LinearIssue[] } };
    };
    return body.data?.issues?.nodes ?? [];
  }
}
