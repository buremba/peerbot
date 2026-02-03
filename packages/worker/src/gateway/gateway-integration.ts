/**
 * HTTP implementation of WorkerTransport
 * Sends worker responses to gateway via HTTP POST requests
 */

import {
  createLogger,
  type WorkerTransport,
  type WorkerTransportConfig,
} from "@peerbot/core";
import type { ResponseData } from "./types";

const logger = createLogger("http-worker-transport");

/**
 * HTTP transport for worker-to-gateway communication
 * Implements retry logic and deduplication for streaming responses
 */
export class HttpWorkerTransport implements WorkerTransport {
  private gatewayUrl: string;
  private workerToken: string;
  private userId: string;
  private channelId: string;
  private threadId: string;
  private originalMessageTs: string;
  private botResponseTs?: string;
  public processedMessageIds: string[] = [];
  private jobId?: string;
  private moduleData?: Record<string, unknown>;
  private teamId: string;
  private platform?: string;
  private accumulatedStreamContent: string[] = [];
  private lastStreamDelta: string = "";

  constructor(config: WorkerTransportConfig) {
    this.gatewayUrl = config.gatewayUrl;
    this.workerToken = config.workerToken;
    this.userId = config.userId;
    this.channelId = config.channelId;
    this.threadId = config.threadId;
    this.originalMessageTs = config.originalMessageTs;
    this.botResponseTs = config.botResponseTs;
    this.teamId = config.teamId;
    this.platform = config.platform;
    this.processedMessageIds = config.processedMessageIds || [];
  }

  setJobId(jobId: string): void {
    this.jobId = jobId;
  }

  setModuleData(moduleData: Record<string, unknown>): void {
    this.moduleData = moduleData;
  }

  async signalDone(finalDelta?: string): Promise<void> {
    // Send final delta if there is one
    if (finalDelta) {
      await this.sendStreamDelta(finalDelta, false, true);
    }
    await this.signalCompletion();
  }

  async sendStreamDelta(
    delta: string,
    isFullReplacement: boolean = false,
    isFinal: boolean = false
  ): Promise<void> {
    let actualDelta = delta;

    // Handle final result with deduplication
    if (isFinal) {
      logger.info(`🔍 Processing final result with deduplication`);
      logger.info(`Final text length: ${delta.length} chars`);
      const accumulatedStr = this.accumulatedStreamContent.join("");
      const accumulatedLength = accumulatedStr.length;
      logger.info(`Accumulated length: ${accumulatedLength} chars`);

      // Check if final result is identical to what we've already sent
      if (delta === accumulatedStr) {
        logger.info(
          `✅ Final result is identical to accumulated content - skipping duplicate`
        );
        return;
      }

      // Check if accumulated content is a prefix of final result
      if (delta.startsWith(accumulatedStr)) {
        // Only send the missing part
        actualDelta = delta.slice(accumulatedLength);
        if (actualDelta.length === 0) {
          logger.info(
            `✅ Final result fully contained in accumulated content - skipping`
          );
          return;
        }
        logger.info(
          `📝 Final result has ${actualDelta.length} new chars - sending delta only`
        );
      } else if (accumulatedLength > 0) {
        const normalizedFinal = this.normalizeForComparison(delta);
        const normalizedLastDelta = this.normalizeForComparison(
          this.lastStreamDelta
        );

        if (
          normalizedFinal.length > 0 &&
          normalizedFinal === normalizedLastDelta
        ) {
          logger.info(
            `✅ Final result matches last streamed delta (normalized) - skipping duplicate`
          );
          return;
        }

        // Content differs - log warning and send full final result
        logger.warn(`⚠️  Final result differs from accumulated content!`);
        logger.warn(
          `First 100 chars of accumulated: ${accumulatedStr.substring(0, 100)}`
        );
        logger.warn(`First 100 chars of final: ${delta.substring(0, 100)}`);
        logger.info(`📤 Sending full final result (${delta.length} chars)`);
      }
    }

    // Track accumulated content for deduplication using array buffer (O(1) append)
    if (!isFullReplacement) {
      this.accumulatedStreamContent.push(actualDelta);
    } else {
      this.accumulatedStreamContent = [actualDelta];
    }
    this.lastStreamDelta = actualDelta;

    await this.sendResponse({
      messageId: this.originalMessageTs,
      channelId: this.channelId,
      threadId: this.threadId,
      userId: this.userId,
      teamId: this.teamId,
      delta: actualDelta,
      timestamp: Date.now(),
      originalMessageId: this.originalMessageTs,
      botResponseId: this.botResponseTs,
      moduleData: this.moduleData,
      isFullReplacement,
    });
  }

  async signalCompletion(): Promise<void> {
    await this.sendResponse({
      messageId: this.originalMessageTs,
      channelId: this.channelId,
      threadId: this.threadId,
      userId: this.userId,
      teamId: this.teamId,
      timestamp: Date.now(),
      originalMessageId: this.originalMessageTs,
      processedMessageIds: this.processedMessageIds,
      botResponseId: this.botResponseTs,
      moduleData: this.moduleData,
    });
  }

  async signalError(error: Error): Promise<void> {
    await this.sendResponse({
      messageId: this.originalMessageTs,
      channelId: this.channelId,
      threadId: this.threadId,
      userId: this.userId,
      teamId: this.teamId,
      error: error.message,
      timestamp: Date.now(),
      originalMessageId: this.originalMessageTs,
      botResponseId: this.botResponseTs,
    });
  }

  async sendStatusUpdate(elapsedSeconds: number, state: string): Promise<void> {
    await this.sendResponse({
      messageId: this.originalMessageTs,
      channelId: this.channelId,
      threadId: this.threadId,
      userId: this.userId,
      teamId: this.teamId,
      timestamp: Date.now(),
      originalMessageId: this.originalMessageTs,
      botResponseId: this.botResponseTs,
      statusUpdate: {
        elapsedSeconds,
        state,
      },
    });
  }

  /**
   * Build base response payload with common fields
   */
  private buildExecResponse(
    execId: string,
    additionalFields: Partial<ResponseData>
  ): ResponseData {
    return {
      messageId: this.originalMessageTs,
      channelId: this.channelId,
      threadId: this.threadId,
      userId: this.userId,
      teamId: this.teamId,
      timestamp: Date.now(),
      originalMessageId: this.originalMessageTs,
      execId,
      ...additionalFields,
    };
  }

  /**
   * Send exec output (stdout/stderr) to gateway
   */
  async sendExecOutput(
    execId: string,
    stream: "stdout" | "stderr",
    content: string
  ): Promise<void> {
    await this.sendResponse(
      this.buildExecResponse(execId, { delta: content, execStream: stream })
    );
  }

  /**
   * Send exec completion to gateway
   */
  async sendExecComplete(execId: string, exitCode: number): Promise<void> {
    await this.sendResponse(
      this.buildExecResponse(execId, { execExitCode: exitCode })
    );
  }

  /**
   * Send exec error to gateway
   */
  async sendExecError(execId: string, errorMessage: string): Promise<void> {
    await this.sendResponse(
      this.buildExecResponse(execId, { error: errorMessage })
    );
  }

  private async sendResponse(data: ResponseData): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const responseUrl = `${this.gatewayUrl}/worker/response`;
        const basePayload =
          this.platform && !data.platform
            ? { ...data, platform: this.platform }
            : data;
        const payload = this.jobId
          ? { jobId: this.jobId, ...basePayload }
          : basePayload;

        // Log the payload for debugging
        logger.info(
          `[WORKER-HTTP] Sending to ${responseUrl}: ${JSON.stringify(payload).substring(0, 500)}`
        );
        if (payload.delta) {
          logger.info(
            `[WORKER-HTTP] Stream delta payload: deltaLength=${payload.delta?.length}`
          );
        }

        const response = await fetch(responseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.workerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(
            `Failed to send response to dispatcher: ${response.status} ${response.statusText}`
          );
        }

        logger.debug("Response sent to dispatcher successfully");
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(
          `Failed to send response (attempt ${attempt + 1}/${maxRetries}):`,
          error
        );

        if (attempt < maxRetries - 1) {
          const delay = 1000 * 2 ** attempt;
          logger.debug(`Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    logger.error(
      "All retry attempts failed for sending response to dispatcher"
    );
    throw lastError;
  }

  private normalizeForComparison(text: string): string {
    return text.replace(/\r\n/g, "\n").trim();
  }
}
