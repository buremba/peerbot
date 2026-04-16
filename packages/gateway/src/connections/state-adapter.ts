import type Redis from "ioredis";
import type { StateAdapter } from "chat";
import { createLogger } from "@lobu/core";

const logger = createLogger("chat-state");

export async function createGatewayStateAdapter(
  redis: Redis
): Promise<StateAdapter> {
  const { createIoRedisState } = await import("@chat-adapter/state-ioredis");
  return createIoRedisState({
    client: redis,
    keyPrefix: "chat-conn",
    logger,
  } as any) as StateAdapter;
}
