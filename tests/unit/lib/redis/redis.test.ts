import type Redis from "ioredis";
import { createRedis, isRedisReady, pingRedis, withTimeout } from "../../../../src/lib/redis/redis";

function fakeClient(status: string, ping?: () => Promise<string>): Redis {
  return { status, ping: ping ?? (() => Promise.resolve("PONG")) } as unknown as Redis;
}

describe("isRedisReady", () => {
  it("should report ready only when the client status is ready", () => {
    expect(isRedisReady(fakeClient("ready"))).toBe(true);
    expect(isRedisReady(fakeClient("connecting"))).toBe(false);
    expect(isRedisReady(fakeClient("end"))).toBe(false);
  });
});

describe("createRedis", () => {
  it("should create a lazy client that is not ready before connecting", () => {
    const client = createRedis("redis://127.0.0.1:1");

    try {
      expect(isRedisReady(client)).toBe(false);
      expect(client.options.enableOfflineQueue).toBe(false);
      expect(client.options.lazyConnect).toBe(true);
    } finally {
      client.disconnect();
    }
  });
});

describe("withTimeout", () => {
  it("should resolve with the value when the command finishes in time", async () => {
    await expect(withTimeout(Promise.resolve("PONG"), 50)).resolves.toBe("PONG");
  });

  it("should reject with redis_timeout when the command is too slow", async () => {
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => {
        resolve("late");
      }, 80);
    });

    await expect(withTimeout(slow, 10)).rejects.toThrow("redis_timeout");
  });
});

describe("pingRedis", () => {
  it("should report down without sending a command when the client is not ready", async () => {
    const ping = jest.fn<Promise<string>, []>();

    await expect(pingRedis(fakeClient("connecting", ping), 50)).resolves.toBe("down");
    expect(ping).not.toHaveBeenCalled();
  });

  it("should report up when the ping answers in time", async () => {
    await expect(pingRedis(fakeClient("ready"), 50)).resolves.toBe("up");
  });

  it("should report down when the ping rejects", async () => {
    const client = fakeClient("ready", () => Promise.reject(new Error("connection lost")));

    await expect(pingRedis(client, 50)).resolves.toBe("down");
  });

  it("should report down when the ping exceeds the timeout", async () => {
    const client = fakeClient(
      "ready",
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve("PONG");
          }, 80);
        }),
    );

    await expect(pingRedis(client, 10)).resolves.toBe("down");
  });
});
