import { Redis } from "ioredis";
import { createAdapter } from "@socket.io/redis-adapter";
import { config } from "./config";

export function createRedisAdapter() {
  if (!config.redis.url) throw new Error("Redis URL required to enable the multi-instance adapter (set REDISCLOUD_URL)");
  const pubClient = new Redis(config.redis.url);
  const subClient = pubClient.duplicate();
  return createAdapter(pubClient, subClient);
}
