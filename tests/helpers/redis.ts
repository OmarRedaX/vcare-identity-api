import type Redis from "ioredis";
import { createRedis, redis } from "../../src/lib/redis/redis";

const TEST_KEY_PATTERNS = ["idem:*", "rl:*"];

async function ensureConnected(client: Redis): Promise<void> {
  if (client.status === "ready") {
    return;
  }
  if (client.status === "wait" || client.status === "end") {
    await client.connect();
  }
}

/** Clears only the keys the foundation writes, on the configured test database index. */
export async function flushTestKeys(client: Redis = redis): Promise<void> {
  await ensureConnected(client);

  for (const pattern of TEST_KEY_PATTERNS) {
    let cursor = "0";
    do {
      const [next, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 200);
      cursor = next;
      if (keys.length > 0) {
        await client.del(...keys);
      }
    } while (cursor !== "0");
  }
}

/** A real client that can never connect — used for "Redis is down" scenarios, not a mock. */
export function createUnreachableRedis(): Redis {
  return createRedis("redis://127.0.0.1:1");
}

export async function closeRedis(client: Redis = redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
