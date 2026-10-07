import type { Knex } from "knex";
import { ServiceClient } from "../../../../src/app/service-auth/entity/service-client.entity";
import { ServiceAuthService } from "../../../../src/app/service-auth/service/service-auth.service";
import type { TokenSigner } from "../../../../src/lib/auth/jwt";
import { Logger } from "../../../../src/lib/logger/logger";
import type { PasswordHasher } from "../../../../src/lib/password/password-hasher";
import { HashQueueFull } from "../../../../src/lib/password/semaphore";
import type { Clock } from "../../../../src/lib/time/types";
import type { MockedModule } from "../../../helpers/types";

jest.mock("../../../../src/app/service-auth/repository/service-client.repo", () => ({
  findLiveByClientId: jest.fn(),
  touchLastUsed: jest.fn(),
}));

const repo = jest.requireMock<
  MockedModule<typeof import("../../../../src/app/service-auth/repository/service-client.repo")>
>("../../../../src/app/service-auth/repository/service-client.repo");

const NOW = new Date("2026-10-07T10:00:00.000Z");
const CLIENT_HASH = "$argon2id$v=19$m=19456,t=2,p=1$Y3VycmVudA$Y3VycmVudGhhc2g";
const PREVIOUS_HASH = "$argon2id$v=19$m=19456,t=2,p=1$cHJldmlvdXM$cHJldmlvdXNoYXNo";
const SECRET = "s".repeat(43);
const clock: Clock = { now: () => NOW };

function logSink(): { logger: Logger; lines: () => Record<string, unknown>[]; text: () => string } {
  const written: string[] = [];
  return {
    logger: new Logger({
      service: "identity-service",
      level: "debug",
      production: false,
      sink: (line) => {
        written.push(line);
      },
    }),
    lines: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => written.join(""),
  };
}

function client(overrides: Partial<ServiceClient> = {}): ServiceClient {
  return new ServiceClient({
    id: 7,
    clientId: "care-service",
    name: "Care service",
    clientSecretHash: CLIENT_HASH,
    previousSecretHash: null,
    previousSecretExpiresAt: null,
    allowedScopes: ["users:read", "users:status:write"],
    allowedAudiences: ["vcare-identity"],
    isActive: true,
    secretRotatedAt: null,
    lastUsedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  });
}

interface Harness {
  service: ServiceAuthService;
  hasher: { verify: jest.Mock; verifyDummy: jest.Mock };
  signer: { signServiceToken: jest.Mock };
  sink: ReturnType<typeof logSink>;
}

function harness(): Harness {
  const sink = logSink();
  const hasher = {
    verify: jest.fn().mockResolvedValue({ ok: true, needsRehash: false }),
    verifyDummy: jest.fn().mockResolvedValue(undefined),
  };
  const signer = { signServiceToken: jest.fn().mockResolvedValue("synthetic.service.token") };
  const service = new ServiceAuthService(
    {} as Knex,
    sink.logger,
    clock,
    hasher as unknown as PasswordHasher,
    signer as unknown as TokenSigner,
  );
  return { service, hasher, signer, sink };
}

function command(overrides: Record<string, string> = {}) {
  return {
    clientId: "care-service",
    clientSecret: SECRET,
    scope: "users:read",
    audience: "vcare-identity",
    ...overrides,
  };
}

beforeEach(() => {
  repo.findLiveByClientId.mockResolvedValue(client());
  repo.touchLastUsed.mockResolvedValue(undefined);
});

describe("ServiceAuthService.issueToken", () => {
  it("should sign exactly the requested scopes, de-duplicated in request order, when the secret and allow-lists match", async () => {
    const { service, signer } = harness();

    const result = await service.issueToken(
      command({ scope: "users:status:write users:read users:status:write" }),
    );

    expect(result).toEqual({ accessToken: "synthetic.service.token", scope: "users:status:write users:read" });
    expect(signer.signServiceToken).toHaveBeenCalledWith({
      clientId: "care-service",
      audience: "vcare-identity",
      scopes: ["users:status:write", "users:read"],
    });
  });

  it("should throw the same InvalidCredentials after exactly one verify when the client is unknown, disabled or the secret is wrong", async () => {
    const outcomes: Error[] = [];
    const calls: { verify: number; dummy: number }[] = [];

    for (const found of [undefined, client({ isActive: false }), client()]) {
      repo.findLiveByClientId.mockResolvedValue(found);
      const { service, hasher } = harness();
      hasher.verify.mockResolvedValue({ ok: false, needsRehash: false });

      outcomes.push(await service.issueToken(command()).then(() => new Error("issued"), (err: Error) => err));
      calls.push({ verify: hasher.verify.mock.calls.length, dummy: hasher.verifyDummy.mock.calls.length });
    }

    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes[1]).toBe(outcomes[2]);
    expect(outcomes[0]).toMatchObject({ code: "InvalidCredentials", status: 401 });
    expect(calls.map((call) => call.verify + call.dummy)).toEqual([1, 1, 1]);
    expect(calls[2]).toEqual({ verify: 1, dummy: 0 });
  });

  it("should log the specific denial reason without the secret when an exchange is refused", async () => {
    const { service, hasher, sink } = harness();
    hasher.verify.mockResolvedValue({ ok: false, needsRehash: false });

    await service.issueToken(command()).catch(() => undefined);

    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "service_token_denied", reason: "bad_secret", clientId: "care-service" }),
    );
    expect(sink.text()).not.toContain(SECRET);
    expect(sink.text()).not.toContain(CLIENT_HASH);
  });

  it("should accept the previous secret when it has not expired and refuse it when it has", async () => {
    const live = client({
      previousSecretHash: PREVIOUS_HASH,
      previousSecretExpiresAt: new Date(NOW.getTime() + 60_000),
    });
    const expired = client({
      previousSecretHash: PREVIOUS_HASH,
      previousSecretExpiresAt: new Date(NOW.getTime() - 1_000),
    });

    repo.findLiveByClientId.mockResolvedValue(live);
    const open = harness();
    open.hasher.verify
      .mockResolvedValueOnce({ ok: false, needsRehash: false })
      .mockResolvedValueOnce({ ok: true, needsRehash: false });
    await expect(open.service.issueToken(command())).resolves.toMatchObject({ scope: "users:read" });
    expect(open.hasher.verify.mock.calls.map((call: string[]) => call[0])).toEqual([CLIENT_HASH, PREVIOUS_HASH]);

    repo.findLiveByClientId.mockResolvedValue(expired);
    const closed = harness();
    closed.hasher.verify.mockResolvedValue({ ok: false, needsRehash: false });
    await expect(closed.service.issueToken(command())).rejects.toMatchObject({ code: "InvalidCredentials" });
    expect(closed.hasher.verify).toHaveBeenCalledTimes(1);
    expect(closed.sink.lines()).toContainEqual(expect.objectContaining({ reason: "secret_expired" }));
  });

  it("should ignore needsRehash and still issue the token when the stored hash is outdated", async () => {
    const { service, hasher } = harness();
    hasher.verify.mockResolvedValue({ ok: true, needsRehash: true });

    await expect(service.issueToken(command())).resolves.toMatchObject({ accessToken: "synthetic.service.token" });
  });

  it("should throw InsufficientScope when a scope or the audience is outside the allow-lists", async () => {
    const { service, signer } = harness();

    await expect(service.issueToken(command({ scope: "doctors:read" }))).rejects.toMatchObject({
      code: "InsufficientScope",
      status: 403,
    });
    await expect(service.issueToken(command({ scope: "users:read foo:bar" }))).rejects.toMatchObject({
      code: "InsufficientScope",
    });
    await expect(service.issueToken(command({ audience: "vcare-care" }))).rejects.toMatchObject({
      code: "InsufficientScope",
    });
    expect(signer.signServiceToken).not.toHaveBeenCalled();
  });

  it("should not evaluate scope or audience, and so not reveal the allow-lists, when the secret is wrong", async () => {
    const { service, hasher, signer, sink } = harness();
    hasher.verify.mockResolvedValue({ ok: false, needsRehash: false });

    await expect(service.issueToken(command({ scope: "doctors:read", audience: "vcare-care" }))).rejects.toMatchObject({
      code: "InvalidCredentials",
    });

    expect(signer.signServiceToken).not.toHaveBeenCalled();
    expect(sink.lines().some((line) => line.reason === "scope" || line.reason === "audience")).toBe(false);
  });

  it("should propagate RateLimited with Retry-After when the hash queue is full", async () => {
    const { service, hasher } = harness();
    hasher.verify.mockRejectedValue(HashQueueFull);

    await expect(service.issueToken(command())).rejects.toBe(HashQueueFull);
    expect(HashQueueFull).toMatchObject({ code: "RateLimited", status: 429, retryAfterSeconds: 1 });
  });

  it("should still return the token and log a warning when touching last_used_at fails", async () => {
    const { service, sink } = harness();
    repo.touchLastUsed.mockRejectedValue(new Error("connection reset"));

    const result = await service.issueToken(command());
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.accessToken).toBe("synthetic.service.token");
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "service_client_touch_failed", clientId: "care-service" }),
    );
  });

  it("should touch last_used_at with the clock's now only after a successful exchange", async () => {
    const ok = harness();
    await ok.service.issueToken(command());
    expect(repo.touchLastUsed).toHaveBeenCalledWith(7, NOW, expect.anything());

    repo.touchLastUsed.mockClear();
    const refused = harness();
    refused.hasher.verify.mockResolvedValue({ ok: false, needsRehash: false });
    await refused.service.issueToken(command()).catch(() => undefined);
    expect(repo.touchLastUsed).not.toHaveBeenCalled();
  });

  it("should log service_token_issued with names only and never the secret or the token", async () => {
    const { service, sink } = harness();

    await service.issueToken(command());

    expect(sink.lines()).toContainEqual(
      expect.objectContaining({
        message: "service_token_issued",
        clientId: "care-service",
        audience: "vcare-identity",
        scope: "users:read",
      }),
    );
    expect(sink.text()).not.toContain(SECRET);
    expect(sink.text()).not.toContain("synthetic.service.token");
  });
});
