/**
 * Scheduled Wake-Up Service
 *
 * Allows workers (Claude) to schedule future tasks that will wake them up.
 * Uses Redis for storage and BullMQ for delayed job processing.
 * Supports one-time delays (delayMinutes) and recurring schedules (cron expressions).
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@lobu/core";
import { CronExpressionParser } from "cron-parser";
import type { IMessageQueue, QueueJob } from "../infrastructure/queue";

const logger = createLogger("scheduled-wakeup");

// ============================================================================
// Types
// ============================================================================

export interface ScheduledWakeup {
  id: string;
  deploymentName: string;
  conversationId: string;
  channelId: string;
  userId: string;
  agentId: string;
  teamId: string;
  platform: string;
  task: string;
  context?: Record<string, unknown>;
  scheduledAt: string; // ISO timestamp
  triggerAt: string; // ISO timestamp (next trigger time)
  status: "pending" | "triggered" | "cancelled";
  // Recurring fields
  cron?: string; // Cron expression (if recurring)
  iteration: number; // Current iteration (1-based, starts at 1)
  maxIterations: number; // Max iterations (default 1 for one-time, 10 for recurring)
  isRecurring: boolean; // Quick check flag
}

export interface ScheduleParams {
  deploymentName: string;
  conversationId: string;
  channelId: string;
  userId: string;
  agentId: string;
  teamId: string;
  platform: string;
  task: string;
  context?: Record<string, unknown>;
  // ONE OF: delayMinutes OR cron (not both)
  delayMinutes?: number; // Minutes from now (one-time)
  cron?: string; // Cron expression (recurring)
  maxIterations?: number; // Max iterations for recurring (default 10)
}

interface ScheduledJobPayload {
  scheduleId: string;
  deploymentName: string;
  conversationId: string;
  channelId: string;
  userId: string;
  agentId: string;
  teamId: string;
  platform: string;
}

// ============================================================================
// Constants
// ============================================================================

const QUEUE_NAME = "scheduled_wakeups";
const REDIS_KEY_PREFIX = "schedule:wakeup:";
const REDIS_INDEX_PREFIX = "schedule:deployment:";
const REDIS_AGENT_INDEX_PREFIX = "schedule:agent:";

// Limits
const MAX_PENDING_PER_DEPLOYMENT = 10;
const MAX_DELAY_MINUTES = 1440; // 24 hours
const SCHEDULE_TTL_SECONDS = 60 * 60 * 24 * 8; // 8 days (for recurring schedules)
// Cron-specific limits
const MIN_CRON_INTERVAL_MINUTES = 5; // Minimum 5 minutes between triggers
const MAX_ITERATIONS = 100; // Maximum iterations for recurring
const DEFAULT_RECURRING_ITERATIONS = 10; // Default max iterations for recurring
const MAX_FIRST_TRIGGER_DAYS = 7; // First trigger must be within 7 days

// ============================================================================
// Module-level singleton reference
// ============================================================================

let scheduledWakeupServiceInstance: ScheduledWakeupService | undefined;

/**
 * Set the global ScheduledWakeupService instance
 * Called by CoreServices after initialization
 */
export function setScheduledWakeupService(
  service: ScheduledWakeupService
): void {
  scheduledWakeupServiceInstance = service;
  logger.debug("ScheduledWakeupService instance set");
}

/**
 * Get the global ScheduledWakeupService instance (if available)
 * Used by BaseDeploymentManager for cleanup
 */
export function getScheduledWakeupService():
  | ScheduledWakeupService
  | undefined {
  return scheduledWakeupServiceInstance;
}

// ============================================================================
// Service
// ============================================================================

export class ScheduledWakeupService {
  private queue: IMessageQueue;
  private isInitialized = false;

  constructor(queue: IMessageQueue) {
    this.queue = queue;
  }

  /**
   * Initialize the service - creates queue and starts worker
   */
  async start(): Promise<void> {
    await this.queue.createQueue(QUEUE_NAME);

    // Register worker to process delayed jobs
    await this.queue.work(
      QUEUE_NAME,
      async (job: QueueJob<ScheduledJobPayload>) => {
        await this.processScheduledJob(job);
      }
    );

    this.isInitialized = true;
    logger.debug("Scheduled wakeup service started");
  }

  /**
   * Schedule a future wakeup (one-time or recurring)
   */
  async schedule(params: ScheduleParams): Promise<ScheduledWakeup> {
    if (!this.isInitialized) {
      throw new Error("Scheduled wakeup service not initialized");
    }

    // Validate: must have either delayMinutes OR cron, not both
    if (params.delayMinutes && params.cron) {
      throw new Error(
        "Cannot specify both delayMinutes and cron - use one or the other"
      );
    }
    if (!params.delayMinutes && !params.cron) {
      throw new Error("Must specify either delayMinutes or cron");
    }

    const isRecurring = !!params.cron;
    let triggerAt: Date;
    let delayMs: number;

    if (params.cron) {
      // Validate and parse cron expression
      const cronValidation = this.validateCron(params.cron);
      if (!cronValidation.valid) {
        throw new Error(cronValidation.error);
      }
      triggerAt = cronValidation.firstTrigger!;
      delayMs = triggerAt.getTime() - Date.now();
    } else {
      // Validate delay
      if (
        params.delayMinutes! < 1 ||
        params.delayMinutes! > MAX_DELAY_MINUTES
      ) {
        throw new Error(
          `Delay must be between 1 and ${MAX_DELAY_MINUTES} minutes`
        );
      }
      triggerAt = new Date(Date.now() + params.delayMinutes! * 60 * 1000);
      delayMs = params.delayMinutes! * 60 * 1000;
    }

    // Validate maxIterations
    const maxIterations = params.maxIterations
      ? Math.min(Math.max(1, params.maxIterations), MAX_ITERATIONS)
      : isRecurring
        ? DEFAULT_RECURRING_ITERATIONS
        : 1;

    // Check pending count limit
    const pending = await this.listPending(params.deploymentName);
    if (pending.length >= MAX_PENDING_PER_DEPLOYMENT) {
      throw new Error(
        `Maximum of ${MAX_PENDING_PER_DEPLOYMENT} pending schedules per deployment`
      );
    }

    const redis = this.queue.getRedisClient();
    const scheduleId = randomUUID();
    const now = new Date();

    const schedule: ScheduledWakeup = {
      id: scheduleId,
      deploymentName: params.deploymentName,
      conversationId: params.conversationId,
      channelId: params.channelId,
      userId: params.userId,
      agentId: params.agentId,
      teamId: params.teamId,
      platform: params.platform,
      task: params.task,
      context: params.context,
      scheduledAt: now.toISOString(),
      triggerAt: triggerAt.toISOString(),
      status: "pending",
      // Recurring fields
      cron: params.cron,
      iteration: 1,
      maxIterations,
      isRecurring,
    };

    // Store in Redis with TTL
    const redisKey = `${REDIS_KEY_PREFIX}${scheduleId}`;
    await redis.setex(redisKey, SCHEDULE_TTL_SECONDS, JSON.stringify(schedule));

    // Add to deployment index
    const deploymentIndexKey = `${REDIS_INDEX_PREFIX}${params.deploymentName}`;
    await redis.sadd(deploymentIndexKey, scheduleId);
    await redis.expire(deploymentIndexKey, SCHEDULE_TTL_SECONDS);

    // Add to agent index (for settings UI)
    const agentIndexKey = `${REDIS_AGENT_INDEX_PREFIX}${params.agentId}`;
    await redis.sadd(agentIndexKey, scheduleId);
    await redis.expire(agentIndexKey, SCHEDULE_TTL_SECONDS);

    // Create delayed job in BullMQ
    const jobPayload: ScheduledJobPayload = {
      scheduleId,
      deploymentName: params.deploymentName,
      conversationId: params.conversationId,
      channelId: params.channelId,
      userId: params.userId,
      agentId: params.agentId,
      teamId: params.teamId,
      platform: params.platform,
    };

    await this.queue.send(QUEUE_NAME, jobPayload, {
      delayMs,
      singletonKey: `schedule-${scheduleId}`,
    });

    logger.info(
      {
        scheduleId,
        deploymentName: params.deploymentName,
        triggerAt: triggerAt.toISOString(),
        isRecurring,
        cron: params.cron,
        maxIterations,
      },
      "Scheduled wakeup created"
    );

    return schedule;
  }

  /**
   * Validate a cron expression and return first trigger time
   */
  private validateCron(cronExpr: string): {
    valid: boolean;
    error?: string;
    firstTrigger?: Date;
  } {
    try {
      const interval = CronExpressionParser.parse(cronExpr);

      // Get next two occurrences to check interval
      const first = interval.next().toDate();
      const second = interval.next().toDate();

      // Check minimum interval
      const intervalMs = second.getTime() - first.getTime();
      const intervalMinutes = intervalMs / (60 * 1000);
      if (intervalMinutes < MIN_CRON_INTERVAL_MINUTES) {
        return {
          valid: false,
          error: `Cron interval must be at least ${MIN_CRON_INTERVAL_MINUTES} minutes (got ${intervalMinutes.toFixed(1)} minutes)`,
        };
      }

      // Check first trigger is not too far in the future
      const daysUntilFirst =
        (first.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      if (daysUntilFirst > MAX_FIRST_TRIGGER_DAYS) {
        return {
          valid: false,
          error: `First trigger must be within ${MAX_FIRST_TRIGGER_DAYS} days (got ${daysUntilFirst.toFixed(1)} days)`,
        };
      }

      return { valid: true, firstTrigger: first };
    } catch (error) {
      return {
        valid: false,
        error: `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Cancel a scheduled wakeup
   */
  async cancel(scheduleId: string, deploymentName: string): Promise<boolean> {
    const redis = this.queue.getRedisClient();
    const redisKey = `${REDIS_KEY_PREFIX}${scheduleId}`;

    // Get current schedule
    const data = await redis.get(redisKey);
    if (!data) {
      return false;
    }

    const schedule: ScheduledWakeup = JSON.parse(data);

    // Verify ownership
    if (schedule.deploymentName !== deploymentName) {
      throw new Error("Schedule does not belong to this deployment");
    }

    // Update status to cancelled
    schedule.status = "cancelled";
    await redis.setex(redisKey, 60 * 60, JSON.stringify(schedule)); // Keep for 1 hour for auditing

    // Remove from indices
    const deploymentIndexKey = `${REDIS_INDEX_PREFIX}${deploymentName}`;
    await redis.srem(deploymentIndexKey, scheduleId);

    const agentIndexKey = `${REDIS_AGENT_INDEX_PREFIX}${schedule.agentId}`;
    await redis.srem(agentIndexKey, scheduleId);

    logger.info({ scheduleId, deploymentName }, "Scheduled wakeup cancelled");
    return true;
  }

  /**
   * List pending schedules for a deployment
   */
  async listPending(deploymentName: string): Promise<ScheduledWakeup[]> {
    const redis = this.queue.getRedisClient();
    const deploymentIndexKey = `${REDIS_INDEX_PREFIX}${deploymentName}`;

    const scheduleIds = await redis.smembers(deploymentIndexKey);
    const schedules: ScheduledWakeup[] = [];

    for (const scheduleId of scheduleIds) {
      try {
        const redisKey = `${REDIS_KEY_PREFIX}${scheduleId}`;
        const data = await redis.get(redisKey);
        if (data) {
          const schedule: ScheduledWakeup = JSON.parse(data);
          if (schedule.status === "pending") {
            schedules.push(schedule);
          }
        }
      } catch (error) {
        logger.warn(
          { scheduleId, deploymentName, error },
          "Failed to fetch schedule entry, skipping"
        );
      }
    }

    // Sort by trigger time
    schedules.sort(
      (a, b) =>
        new Date(a.triggerAt).getTime() - new Date(b.triggerAt).getTime()
    );

    return schedules;
  }

  /**
   * List pending schedules for an agent (used by settings UI)
   */
  async listPendingForAgent(agentId: string): Promise<ScheduledWakeup[]> {
    const redis = this.queue.getRedisClient();
    const agentIndexKey = `${REDIS_AGENT_INDEX_PREFIX}${agentId}`;

    const scheduleIds = await redis.smembers(agentIndexKey);
    const schedules: ScheduledWakeup[] = [];

    for (const scheduleId of scheduleIds) {
      try {
        const redisKey = `${REDIS_KEY_PREFIX}${scheduleId}`;
        const data = await redis.get(redisKey);
        if (data) {
          const schedule: ScheduledWakeup = JSON.parse(data);
          if (schedule.status === "pending") {
            schedules.push(schedule);
          }
        }
      } catch (error) {
        logger.warn(
          { scheduleId, agentId, error },
          "Failed to fetch schedule entry, skipping"
        );
      }
    }

    // Sort by trigger time
    schedules.sort(
      (a, b) =>
        new Date(a.triggerAt).getTime() - new Date(b.triggerAt).getTime()
    );

    return schedules;
  }

  /**
   * Cancel a schedule by ID (for settings UI - verifies agent ownership)
   */
  async cancelByAgent(scheduleId: string, agentId: string): Promise<boolean> {
    const redis = this.queue.getRedisClient();
    const redisKey = `${REDIS_KEY_PREFIX}${scheduleId}`;

    // Get current schedule
    const data = await redis.get(redisKey);
    if (!data) {
      return false;
    }

    const schedule: ScheduledWakeup = JSON.parse(data);

    // Verify agent ownership
    if (schedule.agentId !== agentId) {
      throw new Error("Schedule does not belong to this agent");
    }

    // Update status to cancelled
    schedule.status = "cancelled";
    await redis.setex(redisKey, 60 * 60, JSON.stringify(schedule));

    // Remove from indices
    const deploymentIndexKey = `${REDIS_INDEX_PREFIX}${schedule.deploymentName}`;
    await redis.srem(deploymentIndexKey, scheduleId);

    const agentIndexKey = `${REDIS_AGENT_INDEX_PREFIX}${agentId}`;
    await redis.srem(agentIndexKey, scheduleId);

    logger.info({ scheduleId, agentId }, "Scheduled wakeup cancelled by agent");
    return true;
  }

  /**
   * Clean up schedules when a deployment is deleted
   */
  async cleanupForDeployment(deploymentName: string): Promise<void> {
    const redis = this.queue.getRedisClient();
    const deploymentIndexKey = `${REDIS_INDEX_PREFIX}${deploymentName}`;

    const scheduleIds = await redis.smembers(deploymentIndexKey);

    for (const scheduleId of scheduleIds) {
      const redisKey = `${REDIS_KEY_PREFIX}${scheduleId}`;
      const data = await redis.get(redisKey);
      if (data) {
        const schedule: ScheduledWakeup = JSON.parse(data);
        // Remove from agent index
        const agentIndexKey = `${REDIS_AGENT_INDEX_PREFIX}${schedule.agentId}`;
        await redis.srem(agentIndexKey, scheduleId);
      }
      await redis.del(redisKey);
    }

    await redis.del(deploymentIndexKey);

    if (scheduleIds.length > 0) {
      logger.info(
        { deploymentName, count: scheduleIds.length },
        "Cleaned up schedules for deployment"
      );
    }
  }

  /**
   * Process a scheduled job when it triggers
   */
  private async processScheduledJob(
    job: QueueJob<ScheduledJobPayload>
  ): Promise<void> {
    const { scheduleId, deploymentName } = job.data;

    const redis = this.queue.getRedisClient();
    const redisKey = `${REDIS_KEY_PREFIX}${scheduleId}`;

    // Get schedule data
    const data = await redis.get(redisKey);
    if (!data) {
      logger.warn(
        { scheduleId },
        "Schedule not found - may have expired or been deleted"
      );
      return;
    }

    const schedule: ScheduledWakeup = JSON.parse(data);

    // Check if cancelled
    if (schedule.status === "cancelled") {
      logger.info({ scheduleId }, "Schedule was cancelled - skipping");
      return;
    }

    // Build the message to inject into the thread
    const contextStr = schedule.context
      ? `\n\nContext: ${JSON.stringify(schedule.context, null, 2)}`
      : "";

    // Include iteration info for recurring schedules
    const iterationInfo = schedule.isRecurring
      ? ` (iteration ${schedule.iteration} of ${schedule.maxIterations})`
      : "";
    const cronInfo = schedule.cron ? `\nSchedule: ${schedule.cron}` : "";

    const messageText = `[System] Scheduled reminder from yourself${iterationInfo}:

Task: ${schedule.task}${contextStr}

---${cronInfo}
Originally scheduled at: ${schedule.scheduledAt}
Schedule ID: ${schedule.id}`;

    // Enqueue to the main messages queue (same as platform messages)
    await this.queue.send(
      "messages",
      {
        userId: schedule.userId,
        conversationId: schedule.conversationId,
        messageId: `scheduled-${scheduleId}-${schedule.iteration}`,
        channelId: schedule.channelId,
        teamId: schedule.teamId,
        agentId: schedule.agentId,
        botId: "system",
        platform: schedule.platform,
        messageText,
        platformMetadata: {
          isScheduledWakeup: true,
          scheduleId,
          iteration: schedule.iteration,
          maxIterations: schedule.maxIterations,
          isRecurring: schedule.isRecurring,
        },
        agentOptions: {},
      },
      {
        priority: 5, // Medium priority
      }
    );

    logger.info(
      {
        scheduleId,
        deploymentName,
        conversationId: schedule.conversationId,
        iteration: schedule.iteration,
        maxIterations: schedule.maxIterations,
        isRecurring: schedule.isRecurring,
      },
      "Scheduled wakeup triggered - message enqueued"
    );

    // Handle recurring: schedule next iteration or complete
    if (
      schedule.isRecurring &&
      schedule.iteration < schedule.maxIterations &&
      schedule.cron
    ) {
      try {
        // Calculate next trigger from cron
        const interval = CronExpressionParser.parse(schedule.cron);
        const nextTrigger = interval.next().toDate();
        const delayMs = nextTrigger.getTime() - Date.now();

        const nextIteration = schedule.iteration + 1;

        // Create next delayed job
        const jobPayload: ScheduledJobPayload = {
          scheduleId,
          deploymentName: schedule.deploymentName,
          conversationId: schedule.conversationId,
          channelId: schedule.channelId,
          userId: schedule.userId,
          agentId: schedule.agentId,
          teamId: schedule.teamId,
          platform: schedule.platform,
        };

        await this.queue.send(QUEUE_NAME, jobPayload, {
          delayMs,
          singletonKey: `schedule-${scheduleId}-${nextIteration}`,
        });

        // Only increment iteration after queue send succeeds
        schedule.iteration = nextIteration;
        schedule.triggerAt = nextTrigger.toISOString();
        await redis.setex(
          redisKey,
          SCHEDULE_TTL_SECONDS,
          JSON.stringify(schedule)
        );

        logger.info(
          {
            scheduleId,
            nextIteration: schedule.iteration,
            nextTrigger: nextTrigger.toISOString(),
          },
          "Scheduled next recurring iteration"
        );
      } catch (error) {
        logger.error(
          { scheduleId, error },
          "Failed to schedule next recurring iteration"
        );
        // Mark as triggered (completed with error) and clean up
        schedule.status = "triggered";
        await redis.setex(redisKey, 60 * 60, JSON.stringify(schedule));

        const deploymentIndexKey = `${REDIS_INDEX_PREFIX}${deploymentName}`;
        await redis.srem(deploymentIndexKey, scheduleId);
        const agentIndexKey = `${REDIS_AGENT_INDEX_PREFIX}${schedule.agentId}`;
        await redis.srem(agentIndexKey, scheduleId);
      }
    } else {
      // One-time schedule or max iterations reached - mark as triggered and clean up
      schedule.status = "triggered";
      await redis.setex(redisKey, 60 * 60, JSON.stringify(schedule)); // Keep for 1 hour

      // Remove from indices
      const deploymentIndexKey = `${REDIS_INDEX_PREFIX}${deploymentName}`;
      await redis.srem(deploymentIndexKey, scheduleId);

      const agentIndexKey = `${REDIS_AGENT_INDEX_PREFIX}${schedule.agentId}`;
      await redis.srem(agentIndexKey, scheduleId);

      if (schedule.isRecurring) {
        logger.info(
          {
            scheduleId,
            completedIterations: schedule.iteration,
          },
          "Recurring schedule completed all iterations"
        );
      }
    }
  }
}
