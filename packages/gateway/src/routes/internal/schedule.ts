/**
 * Internal Schedule Routes
 *
 * Worker-facing endpoints for scheduling reminders.
 * Used by custom MCP tools (ScheduleReminder, CancelReminder, ListReminders).
 */

import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import type { ScheduledWakeupService } from "../../orchestration/scheduled-wakeup";
import { authenticateWorker } from "./middleware";

const logger = createLogger("internal-schedule-routes");

type WorkerContext = {
  Variables: {
    worker: {
      userId: string;
      conversationId: string;
      channelId: string;
      teamId?: string;
      agentId?: string;
      deploymentName: string;
      platform?: string;
    };
  };
};

/**
 * Create internal schedule routes (Hono)
 */
export function createScheduleRoutes(
  scheduledWakeupService: ScheduledWakeupService
): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  /**
   * Schedule a reminder (one-time or recurring)
   * POST /internal/schedule
   *
   * Body: {
   *   task: string (required)
   *   delayMinutes?: number (one-time, 1-1440)
   *   cron?: string (recurring, e.g., "0,30 * * * *")
   *   maxIterations?: number (for recurring, default 10, max 100)
   *   context?: object (optional)
   * }
   */
  router.post("/internal/schedule", authenticateWorker, async (c) => {
    try {
      const worker = c.get("worker");
      const { delayMinutes, cron, maxIterations, task, context } =
        await c.req.json();

      // Validate task
      if (!task || typeof task !== "string") {
        return c.json({ error: "task is required and must be a string" }, 400);
      }

      if (task.length > 2000) {
        return c.json({ error: "task must be 2000 characters or less" }, 400);
      }

      // Validate: must have either delayMinutes OR cron
      if (delayMinutes && cron) {
        return c.json(
          {
            error:
              "Cannot specify both delayMinutes and cron - use one or the other",
          },
          400
        );
      }

      if (!delayMinutes && !cron) {
        return c.json(
          { error: "Must specify either delayMinutes or cron" },
          400
        );
      }

      // Validate delayMinutes if provided
      if (
        delayMinutes !== undefined &&
        (typeof delayMinutes !== "number" || delayMinutes < 1)
      ) {
        return c.json({ error: "delayMinutes must be a positive number" }, 400);
      }

      // Validate cron if provided
      if (cron !== undefined && typeof cron !== "string") {
        return c.json({ error: "cron must be a string" }, 400);
      }

      // Validate maxIterations if provided
      if (
        maxIterations !== undefined &&
        (typeof maxIterations !== "number" || maxIterations < 1)
      ) {
        return c.json(
          { error: "maxIterations must be a positive number" },
          400
        );
      }

      logger.info(
        {
          deploymentName: worker.deploymentName,
          delayMinutes,
          cron,
          maxIterations,
          taskLength: task.length,
        },
        "Scheduling reminder"
      );

      const schedule = await scheduledWakeupService.schedule({
        deploymentName: worker.deploymentName,
        conversationId: worker.conversationId,
        channelId: worker.channelId,
        userId: worker.userId,
        agentId: worker.agentId || worker.channelId, // Fallback to channelId if no agentId
        teamId: worker.teamId || "default",
        platform: worker.platform || "unknown",
        delayMinutes,
        cron,
        maxIterations,
        task,
        context,
      });

      const recurringInfo = schedule.isRecurring
        ? ` (recurring: ${schedule.cron}, max ${schedule.maxIterations} iterations)`
        : "";

      return c.json({
        scheduleId: schedule.id,
        scheduledFor: schedule.triggerAt,
        isRecurring: schedule.isRecurring,
        cron: schedule.cron,
        maxIterations: schedule.maxIterations,
        message: `Reminder scheduled for ${new Date(schedule.triggerAt).toLocaleString()}${recurringInfo}`,
      });
    } catch (error) {
      logger.error("Failed to schedule reminder:", error);
      return c.json({ error: "Failed to schedule reminder" }, 400);
    }
  });

  /**
   * Cancel a scheduled reminder
   * DELETE /internal/schedule/:scheduleId
   */
  router.delete(
    "/internal/schedule/:scheduleId",
    authenticateWorker,
    async (c) => {
      try {
        const worker = c.get("worker");
        const scheduleId = c.req.param("scheduleId");

        if (!scheduleId) {
          return c.json({ error: "scheduleId is required" }, 400);
        }

        logger.info(
          {
            deploymentName: worker.deploymentName,
            scheduleId,
          },
          "Cancelling reminder"
        );

        const success = await scheduledWakeupService.cancel(
          scheduleId,
          worker.deploymentName
        );

        if (!success) {
          return c.json({
            success: false,
            message: "Schedule not found or already triggered",
          });
        }

        return c.json({
          success: true,
          message: "Reminder cancelled successfully",
        });
      } catch (error) {
        logger.error("Failed to cancel reminder:", error);
        return c.json({ error: "Failed to cancel reminder" }, 400);
      }
    }
  );

  /**
   * List pending reminders
   * GET /internal/schedule
   */
  router.get("/internal/schedule", authenticateWorker, async (c) => {
    try {
      const worker = c.get("worker");

      const schedules = await scheduledWakeupService.listPending(
        worker.deploymentName
      );

      const reminders = schedules.map((s) => {
        const now = Date.now();
        const triggerTime = new Date(s.triggerAt).getTime();
        const minutesRemaining = Math.max(
          0,
          Math.round((triggerTime - now) / 60000)
        );

        return {
          scheduleId: s.id,
          task: s.task,
          scheduledFor: s.triggerAt,
          minutesRemaining,
          // Recurring info
          isRecurring: s.isRecurring,
          cron: s.cron,
          iteration: s.iteration,
          maxIterations: s.maxIterations,
        };
      });

      return c.json({ reminders });
    } catch (error) {
      logger.error("Failed to list reminders:", error);
      return c.json({ error: "Failed to list reminders" }, 500);
    }
  });

  logger.debug("Internal schedule routes registered");
  return router;
}
