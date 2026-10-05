import type Redis from "ioredis";
import { breakerFor, guardedRedisCall, redisUsable } from "../../../../src/lib/redis/redis-guard";

function client(status: string): Redis {
  return { status } as unknown as Redis;
}

describe("redis guard", () => {
  it("should report unusable when the client is not ready", () => {
    expect(redisUsable(client("connecting"))).toBe(false);
  });

  it("should open the breaker after consecutive timeouts and make redisUsable false", async () => {
    const c = client("ready");
    const never = (): Promise<string> => new Promise<string>(() => undefined);
    for (let i = 0; i < 5; i += 1) {
      await expect(guardedRedisCall(c, never(), 5)).rejects.toThrow("redis_timeout");
    }
    expect(breakerFor(c).getState()).toBe("open");
    expect(redisUsable(c)).toBe(false);
  });

  it("should keep the breaker closed when calls succeed", async () => {
    const c = client("ready");
    await expect(guardedRedisCall(c, Promise.resolve("OK"), 50)).resolves.toBe("OK");
    expect(redisUsable(c)).toBe(true);
  });

  it("should keep breakers independent per client", async () => {
    const a = client("ready");
    const b = client("ready");
    for (let i = 0; i < 5; i += 1) {
      await guardedRedisCall(a, Promise.reject(new Error("boom")), 50).catch(() => undefined);
    }
    expect(redisUsable(a)).toBe(false);
    expect(redisUsable(b)).toBe(true);
  });
});
