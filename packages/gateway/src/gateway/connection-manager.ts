#!/usr/bin/env bun

import { createLogger } from "@peerbot/core";

const logger = createLogger("worker-connection-manager");

/**
 * SSE Writer interface - abstracts the response object for SSE
 */
export interface SSEWriter {
  write(data: string): boolean;
  end(): void;
  onClose(callback: () => void): void;
}

interface WorkerConnection {
  deploymentName: string;
  userId: string;
  threadId: string;
  writer: SSEWriter;
  lastActivity: number;
  lastPing: number;
}

/**
 * Manages SSE connections from workers
 * Handles connection lifecycle, heartbeats, and cleanup
 */
export class WorkerConnectionManager {
  private connections: Map<string, WorkerConnection> = new Map();
  private heartbeatInterval: NodeJS.Timeout;
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Send heartbeat pings every 30 seconds
    this.heartbeatInterval = setInterval(() => this.sendHeartbeats(), 30000);

    // Cleanup stale connections every 30 seconds
    this.cleanupInterval = setInterval(
      () => this.cleanupStaleConnections(),
      30000
    );
  }

  /**
   * Register a new worker connection
   */
  addConnection(
    deploymentName: string,
    userId: string,
    threadId: string,
    writer: SSEWriter
  ): void {
    const connection: WorkerConnection = {
      deploymentName,
      userId,
      threadId,
      writer,
      lastActivity: Date.now(),
      lastPing: Date.now(),
    };

    this.connections.set(deploymentName, connection);

    // Send initial connection event
    this.sendSSE(writer, "connected", { deploymentName, userId, threadId });

    logger.info(
      `Worker ${deploymentName} connected (user: ${userId}, thread: ${threadId})`
    );
  }

  /**
   * Remove a worker connection
   */
  removeConnection(deploymentName: string): void {
    const connection = this.connections.get(deploymentName);
    if (connection) {
      try {
        connection.writer.end();
      } catch (error) {
        // Connection may already be closed
        logger.debug(
          `Failed to close connection for ${deploymentName}:`,
          error
        );
      }
      this.connections.delete(deploymentName);
      logger.info(`Worker ${deploymentName} disconnected`);
    }
  }

  /**
   * Get a worker connection
   */
  getConnection(deploymentName: string): WorkerConnection | undefined {
    return this.connections.get(deploymentName);
  }

  /**
   * Check if a worker is connected
   */
  isConnected(deploymentName: string): boolean {
    return this.connections.has(deploymentName);
  }

  /**
   * Update connection activity timestamp
   */
  touchConnection(deploymentName: string): void {
    const connection = this.connections.get(deploymentName);
    if (connection) {
      connection.lastActivity = Date.now();
    }
  }

  /**
   * Send SSE event to a worker
   */
  sendSSE(writer: SSEWriter, event: string, data: unknown): boolean {
    try {
      // Combine into single write to avoid buffering issues
      // Format: event: <event>\ndata: <json>\n\n
      const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const success = writer.write(message);

      if (!success) {
        logger.warn(
          `[SSE] Response stream buffer full for event ${event}, data: ${JSON.stringify(data).substring(0, 100)}`
        );
        return false;
      }

      logger.info(
        `[SSE] Successfully sent ${event} event, data: ${JSON.stringify(data).substring(0, 200)}`
      );
      return true;
    } catch (error) {
      logger.error(
        `[SSE] Failed to send SSE event ${event}:`,
        error,
        `data: ${JSON.stringify(data).substring(0, 100)}`
      );
      return false;
    }
  }

  /**
   * Send heartbeat pings to all connected workers
   */
  private sendHeartbeats(): void {
    const now = Date.now();

    for (const [deploymentName, connection] of this.connections.entries()) {
      try {
        this.sendSSE(connection.writer, "ping", { timestamp: now });
        connection.lastPing = now;
      } catch (error) {
        logger.warn(`Failed to send ping to ${deploymentName}:`, error);
        // Connection might be dead, will be cleaned up by cleanup check
      }
    }
  }

  /**
   * Cleanup stale connections (>10 minutes without activity)
   */
  private cleanupStaleConnections(): void {
    const now = Date.now();
    // Increase timeout to support long-running Claude sessions
    // Configurable via WORKER_STALE_TIMEOUT_MINUTES env var (default: 10 minutes)
    const timeoutMinutes = parseInt(
      process.env.WORKER_STALE_TIMEOUT_MINUTES || "10",
      10
    );
    const staleThreshold = timeoutMinutes * 60 * 1000;

    for (const [deploymentName, connection] of this.connections.entries()) {
      if (now - connection.lastActivity > staleThreshold) {
        logger.info(
          `Cleaning up stale connection: ${deploymentName} (no activity for ${Math.round((now - connection.lastActivity) / 1000)}s)`
        );
        this.removeConnection(deploymentName);
      }
    }
  }

  /**
   * Get all active connection names
   */
  getActiveConnections(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Shutdown connection manager
   */
  shutdown(): void {
    clearInterval(this.heartbeatInterval);
    clearInterval(this.cleanupInterval);

    // Close all connections
    for (const deploymentName of this.connections.keys()) {
      this.removeConnection(deploymentName);
    }
  }
}
