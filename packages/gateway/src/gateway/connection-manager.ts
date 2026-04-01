#!/usr/bin/env bun

import { createLogger } from "@lobu/core";

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
  conversationId: string;
  agentId: string;
  writer: SSEWriter;
  lastActivity: number;
  lastPing: number;
  httpUrl?: string;
}

/**
 * Manages SSE connections from workers
 * Handles connection lifecycle, heartbeats, and cleanup
 */
export class WorkerConnectionManager {
  private connections: Map<string, WorkerConnection> = new Map();
  private agentDeployments: Map<string, Set<string>> = new Map();
  private heartbeatInterval: NodeJS.Timeout;
  private cleanupInterval: NodeJS.Timeout;
  private useLocalhost: boolean;

  constructor() {
    const mode = process.env.DEPLOYMENT_MODE || "";
    this.useLocalhost = mode !== "kubernetes" && mode !== "k8s";
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
    conversationId: string,
    agentId: string,
    writer: SSEWriter,
    httpPort?: number
  ): void {
    // In embedded/Docker mode workers run in-process, so use localhost.
    // In Kubernetes mode each worker is a separate pod addressable by name.
    const httpHost = this.useLocalhost ? "127.0.0.1" : deploymentName;
    const httpUrl = httpPort ? `http://${httpHost}:${httpPort}` : undefined;

    const connection: WorkerConnection = {
      deploymentName,
      userId,
      conversationId,
      agentId,
      writer,
      lastActivity: Date.now(),
      lastPing: Date.now(),
      httpUrl,
    };

    this.connections.set(deploymentName, connection);

    // Maintain agentId → deployments reverse index
    if (!this.agentDeployments.has(agentId)) {
      this.agentDeployments.set(agentId, new Set());
    }
    this.agentDeployments.get(agentId)?.add(deploymentName);

    // Send initial connection event
    this.sendSSE(writer, "connected", {
      deploymentName,
      userId,
      conversationId,
    });

    logger.info(
      `Worker ${deploymentName} connected (user: ${userId}, agent: ${agentId}, conversation: ${conversationId})`
    );
  }

  /**
   * Remove a worker connection
   */
  removeConnection(deploymentName: string, expectedWriter?: SSEWriter): void {
    const connection = this.connections.get(deploymentName);
    if (connection) {
      if (expectedWriter && connection.writer !== expectedWriter) {
        logger.debug(
          `Skipping disconnect for ${deploymentName} because a newer SSE writer is active`
        );
        return;
      }

      // Clean up reverse index
      const deployments = this.agentDeployments.get(connection.agentId);
      if (deployments) {
        deployments.delete(deploymentName);
        if (deployments.size === 0) {
          this.agentDeployments.delete(connection.agentId);
        }
      }

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
      logger.error(`[SSE] Failed to send SSE event ${event}:`, error);
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
   * Get all deployment names for a given agentId
   */
  getDeploymentsForAgent(agentId: string): string[] {
    const deployments = this.agentDeployments.get(agentId);
    return deployments ? Array.from(deployments) : [];
  }

  /**
   * Send an SSE event to all connected workers for a given agentId.
   * Partial failures are logged but don't block.
   */
  notifyAgent(agentId: string, event: string, data: unknown): void {
    const deployments = this.getDeploymentsForAgent(agentId);
    if (deployments.length === 0) {
      logger.debug(
        `No active deployments for agent ${agentId}, skipping ${event} notification`
      );
      return;
    }

    logger.info(
      `Sending ${event} to ${deployments.length} deployment(s) for agent ${agentId}`
    );
    for (const deploymentName of deployments) {
      const connection = this.connections.get(deploymentName);
      if (connection) {
        this.sendSSE(connection.writer, event, data);
      }
    }
  }

  /**
   * Get the HTTP URL for a worker serving the given agentId.
   * Returns the httpUrl of the first connected deployment for the agent.
   */
  getHttpUrl(agentId: string): string | undefined {
    const deployments = this.getDeploymentsForAgent(agentId);
    for (const deploymentName of deployments) {
      const connection = this.connections.get(deploymentName);
      if (connection?.httpUrl) {
        return connection.httpUrl;
      }
    }
    return undefined;
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
