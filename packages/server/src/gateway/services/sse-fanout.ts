/**
 * SseFanout — cross-replica delivery for ephemeral SSE events.
 *
 * `SseManager` is per-pod and in-memory: a broadcast only reaches clients
 * whose SSE connection lives on the broadcasting pod. But the event producers
 * — the thread_response consumer (deltas/status/terminals) and the
 * InteractionService→api bridge (ask_user/approvals) — run on whichever
 * replica claimed the work or spawned the worker, independent of the ClientIP
 * affinity that pins a client's SSE to one pod. So under N>1 replicas an event
 * produced on pod A never reaches a client whose SSE is on pod S.
 *
 * This bridges that gap with Postgres LISTEN/NOTIFY: every broadcast is
 * published on a single `sse_fanout` channel and each replica delivers the
 * events it did NOT originate to its own local connections AND seeds its own
 * backlog — so a client that connects late or fails over to any pod can
 * replay events produced elsewhere. It reuses the shared listener socket the
 * runs queue and caches already multiplex onto (see `getDbListener`) and
 * needs no new table.
 *
 * Best-effort by design: durable terminal/card delivery stays on the
 * thread_response owner-gate in `unified-thread-consumer.ts` (a dropped
 * NOTIFY costs streamed text, not a hung turn). That is also why oversized
 * payloads (> ~7KB, NOTIFY's limit is 8000 bytes) fall back to local-only
 * delivery instead of an indirection table — the gate still guarantees the
 * events that matter. `lobu_sse_fanout_oversize_total` tracks how often this
 * actually happens; revisit (NOTIFY a runs.action_input ref) if it's nonzero
 * in practice and before any future owner-gate removal.
 *
 * Publishes are serialized through a per-process promise chain: NOTIFYs ride
 * the shared pool (up to 20 connections), and concurrent fire-and-forget
 * sends can arrive at peers out of order — which would garble streamed
 * deltas cross-pod. The chain is poison-proof (every link catches) so one
 * failed send never wedges fan-out.
 *
 * Scaling note: this is a broadcast — every replica sees every event. Fine at
 * the replica counts we run; for very large N the next step is targeted
 * delivery via a durable SSE-session→pod registry, swappable behind the
 * `SseFanoutPublisher` interface without touching broadcast call sites.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@lobu/core";
import { getDb, getDbListener } from "../../db/client.js";
import { incrementCounter } from "../metrics/prometheus.js";
import type { SseEvent, SseManager } from "./sse-manager.js";

const logger = createLogger("sse-fanout");

const CHANNEL = "sse_fanout";
// Postgres caps NOTIFY payloads at 8000 bytes; stay well under to leave room
// for JSON framing.
const MAX_PAYLOAD_BYTES = 7000;

type FanoutMessage =
  | {
      kind: "event";
      /** Per-process id of the publishing replica — receivers skip their own. */
      origin: string;
      agentId: string;
      event: string;
      data: unknown;
      /** Original event timestamp, preserved for cross-pod backlog ordering. */
      ts: number;
    }
  | {
      kind: "close";
      origin: string;
      agentId: string;
      reason: string;
    };

export class SseFanout {
  private readonly origin = randomUUID();
  private subscription?: { unlisten: () => Promise<unknown> };
  /** Serialized publish chain — preserves cross-pod delta order. */
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly sseManager: SseManager) {}

  async start(): Promise<void> {
    try {
      this.subscription = await getDbListener().listen(
        CHANNEL,
        (payload) => this.onNotify(payload),
        () => {
          // Fires on initial subscribe and after every listener reconnect.
          // NOTIFYs sent during a reconnect gap are gone — peers' clients
          // recover via backlog replay on their next reconnect.
          logger.debug(
            `LISTEN ${CHANNEL} (re)subscribed (origin=${this.origin})`
          );
        }
      );
      // Only publish when we can also receive — a pod that can't LISTEN
      // behaves exactly like a single replica (local-only broadcasts).
      this.sseManager.setPublisher({
        event: (agentId, entry) => this.publish(agentId, entry),
        close: (agentId, reason) => this.publishClose(agentId, reason),
      });
    } catch (err) {
      // Fail open: without LISTEN, fan-out is disabled and broadcasts stay
      // local-only — identical to single-replica behavior. Under N>1 this
      // means cross-pod streaming is lost (terminal/card delivery still rides
      // the owner-gate); the boot probe in server.ts surfaces the condition.
      logger.error(
        `SSE fan-out LISTEN failed; cross-pod SSE delivery disabled: ${
          (err as Error).message
        }`
      );
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.sseManager.setPublisher(undefined);
    if (this.subscription) {
      try {
        await this.subscription.unlisten();
      } catch {
        // ignore — shutting down
      }
      this.subscription = undefined;
    }
    // Drain pending publishes without surfacing errors (each link catches).
    await this.tail;
  }

  isActive(): boolean {
    return this.subscription !== undefined && !this.stopped;
  }

  /** Publish a locally-broadcast event to peer replicas. */
  private publish(agentId: string, entry: SseEvent): void {
    this.send({
      kind: "event",
      origin: this.origin,
      agentId,
      event: entry.event,
      data: entry.data,
      ts: entry.timestamp,
    });
  }

  /** Tell peer replicas to purge a closed session's connections + backlog. */
  private publishClose(agentId: string, reason: string): void {
    this.send({ kind: "close", origin: this.origin, agentId, reason });
  }

  private send(message: FanoutMessage): void {
    if (this.stopped) return;
    let payload: string;
    try {
      payload = JSON.stringify(message);
    } catch {
      return; // non-serializable payload; local delivery already happened
    }
    if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
      incrementCounter("lobu_sse_fanout_oversize_total");
      logger.warn(
        `SSE fan-out skipped oversized "${message.kind === "event" ? message.event : "close"}" for ${message.agentId} (local-only delivery)`
      );
      return;
    }
    // Serialize sends so NOTIFYs leave in broadcast order even over the
    // connection pool; catch per-link so one failure can't poison the chain.
    this.tail = this.tail.then(async () => {
      try {
        await getDb()`SELECT pg_notify(${CHANNEL}, ${payload})`;
        incrementCounter("lobu_sse_fanout_published_total");
      } catch (err) {
        incrementCounter("lobu_sse_fanout_publish_failed_total");
        logger.debug(`SSE fan-out NOTIFY failed: ${(err as Error).message}`);
      }
    });
  }

  /** Apply a peer's message to this pod's local state. */
  private onNotify(payload: unknown): void {
    if (typeof payload !== "string" || payload.length === 0) return;
    let message: FanoutMessage;
    try {
      message = JSON.parse(payload) as FanoutMessage;
    } catch {
      return;
    }
    // Skip our own NOTIFYs — broadcast()/closeAgent() already ran locally.
    if (!message || message.origin === this.origin) return;
    incrementCounter("lobu_sse_fanout_received_total");
    if (message.kind === "close") {
      this.sseManager.closeFromPeer(message.agentId, message.reason);
      return;
    }
    this.sseManager.deliverFromPeer(message.agentId, {
      event: message.event,
      data: message.data,
      timestamp: message.ts,
    });
  }
}
