/**
 * HTTP implementation of WorkerTransport
 * Sends worker responses to gateway via HTTP POST requests
 */

import {
  createLogger,
  retryWithBackoff,
  type WorkerTransport,
  type WorkerTransportConfig,
} from "@lobu/core";
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
  private conversationId: string;
  private originalMessageTs: string;
  private botResponseTs?: string;
  public processedMessageIds: string[] = [];
  private jobId?: string;
  private moduleData?: Record<string, unknown>;
  private teamId: string;
  private platform?: string;
  private platformMetadata?: Record<string, unknown>;
  private accumulatedStreamContent: string[] = [];
  private lastStreamDelta: string = "";

  constructor(config: WorkerTransportConfig) {
    this.gatewayUrl = config.gatewayUrl;
    this.workerToken = config.workerToken;
    this.userId = config.userId;
    this.channelId = config.channelId;
    this.conversationId = config.conversationId;
    this.originalMessageTs = config.originalMessageTs;
    this.botResponseTs = config.botResponseTs;
    this.teamId = config.teamId;
    this.platform = config.platform;
    this.platformMetadata = config.platformMetadata;
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

    await this.sendResponse(
      this.buildBaseResponse({
        delta: actualDelta,
        moduleData: this.moduleData,
        isFullReplacement,
      })
    );
  }

  async signalCompletion(): Promise<void> {
    await this.sendResponse(
      this.buildBaseResponse({
        processedMessageIds: this.processedMessageIds,
        moduleData: this.moduleData,
      })
    );
  }

  async signalError(error: Error, errorCode?: string): Promise<void> {
    await this.sendResponse(
      this.buildBaseResponse({
        error: error.message,
        ...(errorCode && { errorCode }),
      })
    );
  }

  async sendStatusUpdate(elapsedSeconds: number, state: string): Promise<void> {
    await this.sendResponse(
      this.buildBaseResponse({
        statusUpdate: { elapsedSeconds, state },
      })
    );
  }

  async sendCustomEvent(
    name: string,
    data: Record<string, unknown>
  ): Promise<void> {
    await this.sendResponse(
      this.buildBaseResponse({
        customEvent: { name, data },
      })
    );
  }

  /**
   * Build base response payload with common fields shared across all response types
   */
  private buildBaseResponse(
    additionalFields?: Partial<ResponseData>
  ): ResponseData {
    return {
      messageId: this.originalMessageTs,
      channelId: this.channelId,
      conversationId: this.conversationId,
      userId: this.userId,
      teamId: this.teamId,
      timestamp: Date.now(),
      originalMessageId: this.originalMessageTs,
      botResponseId: this.botResponseTs,
      ...additionalFields,
    };
  }

  /**
   * Build exec response payload with exec-specific fields
   */
  private buildExecResponse(
    execId: string,
    additionalFields: Partial<ResponseData>
  ): ResponseData {
    return this.buildBaseResponse({ execId, ...additionalFields });
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
    const responseUrl = `${this.gatewayUrl}/worker/response`;
    const basePayload = {
      ...data,
      ...(this.platform && !data.platform ? { platform: this.platform } : {}),
      ...(!data.platformMetadata && this.platformMetadata
        ? { platformMetadata: this.platformMetadata }
        : {}),
    };
    const payload = this.jobId
      ? { jobId: this.jobId, ...basePayload }
      : basePayload;

    await retryWithBackoff(
      async () => {
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
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          throw new Error(
            `Failed to send response to dispatcher: ${response.status} ${response.statusText}`
          );
        }

        logger.debug("Response sent to dispatcher successfully");
      },
      {
        maxRetries: 2,
        baseDelay: 1000,
        onRetry: (attempt, error) => {
          logger.warn(`Failed to send response (attempt ${attempt}/2):`, error);
        },
      }
    );
  }

  private normalizeForComparison(text: string): string {
    return text.replace(/\r\n/g, "\n").trim();
  }
}
