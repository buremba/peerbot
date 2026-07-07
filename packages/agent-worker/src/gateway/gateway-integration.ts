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
import { createGatewayClient } from "../shared/gateway-client";
import type { ResponseData } from "./types";
import { getWorkerTokenManager } from "./worker-token-manager";

const logger = createLogger("http-worker-transport");

/**
 * HTTP transport for worker-to-gateway communication
 * Implements retry logic and deduplication for streaming responses
 */
export class HttpWorkerTransport implements WorkerTransport {
  private gatewayUrl: string;
  private userId: string;
  private channelId: string;
  private conversationId: string;
  private originalMessageTs: string;
  private botResponseTs?: string;
  public processedMessageIds: string[] = [];
  private jobId?: string;
  private teamId: string;
  private platform?: string;
  private platformMetadata?: Record<string, unknown>;
  private accumulatedStreamContent: string[] = [];
  private lastStreamDelta: string = "";
  // The authoritative full assistant text, recorded whenever the worker sees
  // an explicit final result (the `isFinal` delta). `signalCompletion()` sends
  // THIS as `finalText` rather than re-deriving it from the append-only
  // `accumulatedStreamContent` dedupe buffer. The buffer can hold
  // partial_stream + full_final in the divergent-final case (when the final
  // result is neither identical to nor a prefix-extension of what was
  // streamed), which would garble the cross-pod/history `finalText`.
  // `undefined` until an explicit final is seen — pure-streaming turns fall
  // back to the accumulation (which IS the final text there).
  private finalText?: string;

  constructor(config: WorkerTransportConfig) {
    this.gatewayUrl = config.gatewayUrl;
    // Seed the process-wide token manager from the boot token if it hasn't been
    // initialized yet (the manager otherwise lazy-inits from env). The manager
    // is the single source of truth for the live token — this transport's
    // gateway POSTs read it via fetchWithRefresh, so there is no per-transport
    // token field to drift.
    getWorkerTokenManager().seed(config.workerToken);
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
      // `delta` is the complete final assistant text. Record it as the
      // authoritative `finalText` regardless of which dedupe branch we take
      // below — the dedupe only controls what (if anything) is *streamed* to
      // the client, never what the terminal completion row carries cross-pod.
      this.finalText = delta;

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
        isFullReplacement,
      })
    );
  }

  async signalCompletion(): Promise<void> {
    // Carry the full assistant text on the terminal row. The reply text is
    // otherwise only in the gateway's per-pod streaming buffer (built from the
    // delta rows on whichever replica drained them); a post-once renderer
    // (Slack) that completes on a different replica has no buffer and would
    // drop the reply. `finalText` makes the completion self-contained so any
    // replica can deliver it. (Empty string when nothing was streamed.)
    //
    // Prefer the authoritative final recorded from the `isFinal` delta. Only
    // fall back to the accumulated stream buffer when no explicit final was
    // seen (a pure-streaming turn, where the accumulation IS the final text).
    // Re-deriving from the buffer unconditionally would garble the divergent-
    // final case, where it holds partial_stream + full_final.
    await this.sendResponse(
      this.buildBaseResponse({
        processedMessageIds: this.processedMessageIds,
        finalText: this.finalText ?? this.accumulatedStreamContent.join(""),
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
        // Don't `JSON.stringify(payload)` just to truncate it for a log line —
        // that's a full serialize-then-discard on the per-delta hot path
        // (and platformMetadata can be large). Log the identifying fields only.
        logger.info(
          `[WORKER-HTTP] Sending to ${responseUrl}: messageId=${payload.messageId ?? ""}${
            payload.delta ? ` deltaLength=${payload.delta.length}` : ""
          }${payload.statusUpdate ? " statusUpdate" : ""}${payload.customEvent ? ` customEvent=${payload.customEvent.name}` : ""}`
        );

        // Route through the token manager so a turn running past the token's
        // 2h TTL refreshes (proactively when near expiry, reactively on a 401)
        // against the deployment-liveness-gated /worker/token/refresh endpoint.
        // The manager is the single source of truth for the live token; it
        // hands the current token to this callback, which binds a fresh gateway
        // client to that live bearer for each (re)try — keeping the shared
        // auth/content-type/timeout boilerplate from the gateway client.
        const response = await getWorkerTokenManager().fetchWithRefresh((tok) =>
          createGatewayClient({ baseUrl: this.gatewayUrl, token: tok }).request(
            "/worker/response",
            {
              method: "POST",
              body: JSON.stringify(payload),
              timeoutMs: 30_000,
            }
          )
        );

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
