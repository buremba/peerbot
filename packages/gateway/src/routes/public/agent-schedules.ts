/**
 * Agent Schedules Routes
 *
 * Schedule management endpoints mounted under /api/v1/agents/{agentId}/schedules
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store";
import {
  type SettingsTokenPayload,
  verifySettingsToken,
} from "../../auth/settings/token-service";
import type { UserAgentsStore } from "../../auth/user-agents-store";
import type { ScheduledWakeupService } from "../../orchestration/scheduled-wakeup";

const TAG = "Agents";
const ErrorResponse = z.object({ error: z.string() });
const TokenQuery = z.object({ token: z.string() });

// --- Route Definitions ---

const listSchedulesRoute = createRoute({
  method: "get",
  path: "/",
  tags: [TAG],
  summary: "List agent schedules",
  request: { query: TokenQuery },
  responses: {
    200: {
      description: "Schedules",
      content: {
        "application/json": {
          schema: z.object({
            schedules: z.array(
              z.object({
                scheduleId: z.string(),
                conversationId: z.string(),
                task: z.string(),
                scheduledAt: z.number(),
                scheduledFor: z.number(),
                status: z.string(),
              })
            ),
          }),
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

const cancelScheduleRoute = createRoute({
  method: "delete",
  path: "/{scheduleId}",
  tags: [TAG],
  summary: "Cancel agent schedule",
  request: {
    query: TokenQuery,
    params: z.object({ scheduleId: z.string() }),
  },
  responses: {
    200: {
      description: "Cancelled",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            message: z.string().optional(),
          }),
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export interface AgentSchedulesRoutesConfig {
  scheduledWakeupService?: ScheduledWakeupService;
  userAgentsStore?: UserAgentsStore;
  agentMetadataStore?: AgentMetadataStore;
}

export function createAgentSchedulesRoutes(
  config: AgentSchedulesRoutesConfig
): OpenAPIHono {
  const app = new OpenAPIHono();

  const verifyToken = async (
    token: string | undefined,
    agentId: string
  ): Promise<SettingsTokenPayload | null> => {
    if (!token) return null;
    const payload = verifySettingsToken(token);
    if (!payload) return null;

    if (payload.agentId) {
      if (payload.agentId !== agentId) return null;
    } else if (config.userAgentsStore) {
      const owns = await config.userAgentsStore.ownsAgent(
        payload.platform,
        payload.userId,
        agentId
      );
      if (!owns) {
        if (config.agentMetadataStore) {
          const metadata = await config.agentMetadataStore.getMetadata(agentId);
          if (!metadata?.isWorkspaceAgent) return null;
        } else {
          return null;
        }
      }
    }
    return payload;
  };

  app.openapi(listSchedulesRoute, async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const payload = await verifyToken(c.req.valid("query").token, agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    if (!config.scheduledWakeupService) return c.json({ schedules: [] });

    const schedules =
      await config.scheduledWakeupService.listPendingForAgent(agentId);
    return c.json({
      schedules: schedules.map((s) => ({
        scheduleId: s.id,
        conversationId: s.conversationId,
        task: s.task,
        scheduledAt: s.scheduledAt,
        scheduledFor: s.triggerAt,
        status: s.status,
      })),
    });
  });

  app.openapi(cancelScheduleRoute, async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const payload = await verifyToken(c.req.valid("query").token, agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    if (!config.scheduledWakeupService) {
      return c.json({ error: "Not configured" }, 500);
    }

    const { scheduleId } = c.req.valid("param");
    const success = await config.scheduledWakeupService.cancelByAgent(
      scheduleId,
      agentId
    );

    return c.json({
      success,
      message: success ? undefined : "Not found or already triggered",
    });
  });

  return app;
}
