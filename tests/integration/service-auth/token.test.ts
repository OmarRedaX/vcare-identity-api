import type { Express } from "express";
import knex from "knex";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import request from "supertest";
import { buildTestApps } from "../../helpers/app";
import { mutableClock, seedUser } from "../../helpers/auth";
import {
  contractOperation,
  contractRequired,
  expectContractDeclares,
  expectErrorEnvelope,
  expectSuccessEnvelope,
  schemaBlock,
} from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { captureLogs } from "../../helpers/log-capture";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import {
  lastUsedAt,
  postToken,
  postTokenForm,
  seedServiceClient,
  tokenBody,
  waitForLastUsed,
} from "../../helpers/service-clients";
import { signAccessToken } from "../../helpers/tokens";
import { db } from "../../../src/lib/knex/knex";
import { buildKnexConfig } from "../../../src/lib/knex/knexfile";
import { randomUuid } from "../../../src/pkg/utils/crypto";

const OPERATION = "/internal/auth/token";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let apps: { publicApp: Express; internalApp: Express };

beforeAll(() => {
  apps = buildTestApps();
});

beforeEach(async () => {
  await truncateAll();
  await flushTestKeys();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

interface TokenData {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

async function verifyAgainstJwks(token: string) {
  const jwks = await request(apps.publicApp).get("/.well-known/jwks.json");
  return jwtVerify(token, createLocalJWKSet(jwks.body as JSONWebKeySet), {
    issuer: "vcare-identity",
    audience: "vcare-identity",
  });
}

function errorWithoutRequestId(response: request.Response): unknown {
  const body = response.body as { error: Record<string, unknown> };
  return { ...body.error, requestId: undefined };
}

describe("POST /internal/auth/token: contract conformance", () => {
  it("should return 200 with the ServiceTokenResponse shape and no-store headers when a JSON exchange succeeds", async () => {
    const client = await seedServiceClient();

    const response = await postToken(apps.internalApp, tokenBody(client, { scope: "users:read users:status:write" }));

    expect(response.status).toBe(200);
    const data = expectSuccessEnvelope(response.body) as TokenData;
    expect(Object.keys(data).sort()).toEqual([...contractRequired("ServiceTokenResponse")].sort());
    expect(data.token_type).toBe("Bearer");
    expect(data.expires_in).toBe(300);
    expect(data.scope).toBe("users:read users:status:write");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toMatch(UUID);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expectContractDeclares(OPERATION, "post", 200);
  });

  it("should return the same 200 shape when the exchange is form-encoded", async () => {
    const client = await seedServiceClient();
    const { secret } = client;

    const response = await postTokenForm(apps.internalApp, {
      grant_type: "client_credentials",
      client_id: client.clientId,
      client_secret: secret,
      scope: "users:read",
      audience: "vcare-identity",
    });

    expect(response.status).toBe(200);
    const data = expectSuccessEnvelope(response.body) as TokenData;
    expect(Object.keys(data).sort()).toEqual([...contractRequired("ServiceTokenResponse")].sort());
    expect(data.scope).toBe("users:read");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("should issue a token that verifies against the published JWKS with exactly the BR-7 claims", async () => {
    const client = await seedServiceClient();

    const response = await postToken(apps.internalApp, tokenBody(client, { scope: "users:read users:status:write" }));
    const { access_token: token } = (response.body as { data: TokenData }).data;
    const { payload, protectedHeader } = await verifyAgainstJwks(token);

    expect(protectedHeader.alg).toBe("EdDSA");
    expect(typeof protectedHeader.kid).toBe("string");
    expect(payload.iss).toBe("vcare-identity");
    expect(payload.sub).toBe(client.clientId);
    expect(payload.typ).toBe("service");
    expect(payload.aud).toBe("vcare-identity");
    expect(payload.scope).toBe("users:read users:status:write");
    expect(typeof payload.jti).toBe("string");
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "scope", "sub", "typ"]);
  });

  it("should declare every status and error code this route returns when read from the contract", () => {
    const operation = contractOperation(OPERATION, "post");

    expect(operation.statuses.sort()).toEqual(["200", "400", "401", "403", "429", "500"]);
    expect(operation.errorCodes.sort()).toEqual(
      ["InsufficientScope", "InternalError", "InvalidCredentials", "RateLimited", "ValidationFailed"],
    );
    const schema = schemaBlock("ServiceTokenRequest");
    expect(schema).toMatch(/scope:.*maxLength: 256/);
    expect(schema).toMatch(/audience:.*maxLength: 64/);
  });

  it("should echo the caller X-Request-Id and put it on the service_token_issued log line", async () => {
    const client = await seedServiceClient();
    const requestId = randomUuid();
    const logs = captureLogs({ level: "info" });

    let response: request.Response;
    try {
      response = await postToken(apps.internalApp, tokenBody(client), requestId);
    } finally {
      logs.restore();
    }

    expect(response.headers["x-request-id"]).toBe(requestId);
    const issued = logs.lines().find((line) => line.message === "service_token_issued");
    expect(issued).toMatchObject({
      requestId,
      clientId: client.clientId,
      audience: "vcare-identity",
      scope: "users:read",
    });
  });

  it("should ignore a user bearer token and an Idempotency-Key when the exchange is made", async () => {
    const client = await seedServiceClient();
    const admin = await seedUser({ email: "admin.token@example.test", role: "admin" });

    const response = await postToken(apps.internalApp, tokenBody(client))
      .set("Authorization", `Bearer ${await signAccessToken(admin)}`)
      .set("Idempotency-Key", randomUuid());

    expect(response.status).toBe(200);
  });

  it("should answer 404 on the public listener when the token route is requested there", async () => {
    const client = await seedServiceClient();

    const response = await request(apps.publicApp).post(OPERATION).send(tokenBody(client));

    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, "NotFound");
  });
});

describe("POST /internal/auth/token: credentials", () => {
  it("should return an identical 401 InvalidCredentials when the client is unknown, disabled, soft-deleted or the secret is wrong", async () => {
    const wrong = await seedServiceClient({ clientId: "wrong-secret-client" });
    const disabled = await seedServiceClient({ clientId: "disabled-client", isActive: false });
    const deleted = await seedServiceClient({ clientId: "deleted-client", deletedAt: new Date() });

    const responses = [
      await postToken(apps.internalApp, tokenBody(wrong, { client_secret: "x".repeat(43) })),
      await postToken(apps.internalApp, tokenBody({ ...wrong, clientId: "no-such-client" })),
      await postToken(apps.internalApp, tokenBody(disabled)),
      await postToken(apps.internalApp, tokenBody(deleted)),
    ];

    for (const response of responses) {
      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, "InvalidCredentials");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    const [first, ...rest] = responses;
    for (const response of rest) {
      expect(errorWithoutRequestId(response)).toEqual(errorWithoutRequestId(first as request.Response));
    }
    expectContractDeclares(OPERATION, "post", 401, "InvalidCredentials");
  });

  it("should accept the previous secret until it expires and the new secret throughout when a rotation window is open", async () => {
    const oldSecret = "o".repeat(43);
    const open = await seedServiceClient({
      clientId: "rotating-open",
      previous: { secret: oldSecret, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const closed = await seedServiceClient({
      clientId: "rotating-closed",
      previous: { secret: oldSecret, expiresAt: new Date(Date.now() - 3_600_000) },
    });

    const newSecretOpen = await postToken(apps.internalApp, tokenBody(open));
    const oldSecretOpen = await postToken(apps.internalApp, tokenBody(open, { client_secret: oldSecret }));
    const newSecretClosed = await postToken(apps.internalApp, tokenBody(closed));
    const oldSecretClosed = await postToken(apps.internalApp, tokenBody(closed, { client_secret: oldSecret }));

    expect(newSecretOpen.status).toBe(200);
    expect(oldSecretOpen.status).toBe(200);
    expect(newSecretClosed.status).toBe(200);
    expect(oldSecretClosed.status).toBe(401);
    expectErrorEnvelope(oldSecretClosed.body, "InvalidCredentials");
  });

  it("should not reveal the allow-lists when the secret is wrong, even for a scope or audience the client may not have", async () => {
    const client = await seedServiceClient({ scopes: ["users:read"] });

    const response = await postToken(
      apps.internalApp,
      tokenBody(client, { client_secret: "y".repeat(43), scope: "users:status:write", audience: "vcare-care" }),
    );

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, "InvalidCredentials");
  });
});

describe("POST /internal/auth/token: scope and audience", () => {
  it("should grant exactly the requested subset, de-duplicated in request order, when the scopes are allowed", async () => {
    const client = await seedServiceClient({ scopes: ["users:read", "users:status:write", "doctors:read"] });

    const subset = await postToken(apps.internalApp, tokenBody(client, { scope: "users:status:write" }));
    const duplicated = await postToken(
      apps.internalApp,
      tokenBody(client, { scope: "users:status:write users:read users:status:write" }),
    );

    expect((subset.body as { data: TokenData }).data.scope).toBe("users:status:write");
    expect((duplicated.body as { data: TokenData }).data.scope).toBe("users:status:write users:read");
  });

  it("should return 403 InsufficientScope when a scope is outside the client's allowed scopes or unknown", async () => {
    const client = await seedServiceClient({ scopes: ["users:read"] });

    for (const scope of ["users:status:write", "users:read doctors:read", "foo:bar"]) {
      const response = await postToken(apps.internalApp, tokenBody(client, { scope }));

      expect(response.status).toBe(403);
      expectErrorEnvelope(response.body, "InsufficientScope");
    }
    expectContractDeclares(OPERATION, "post", 403, "InsufficientScope");
  });

  it("should return 403 InsufficientScope when the audience is outside the client's allowed audiences", async () => {
    const client = await seedServiceClient({ audiences: ["vcare-identity"] });

    const response = await postToken(apps.internalApp, tokenBody(client, { audience: "vcare-care" }));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, "InsufficientScope");
  });

  it("should issue the requested audience as a single string when the client holds several audiences", async () => {
    const client = await seedServiceClient({ audiences: ["vcare-identity", "vcare-care"] });

    const response = await postToken(apps.internalApp, tokenBody(client, { audience: "vcare-care" }));
    const token = (response.body as { data: TokenData }).data.access_token;
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      aud: unknown;
    };

    expect(response.status).toBe(200);
    expect(payload.aud).toBe("vcare-care");
  });
});

describe("POST /internal/auth/token: validation", () => {
  it("should return 400 ValidationFailed naming the field when a field is missing, malformed or unknown", async () => {
    const client = await seedServiceClient();
    const cases: [Record<string, unknown>, string][] = [
      [tokenBody(client, { grant_type: "password" }), "grant_type"],
      [tokenBody(client, { client_id: "Not A Client" }), "client_id"],
      [tokenBody(client, { client_secret: "too-short" }), "client_secret"],
      [tokenBody(client, { client_secret: "z".repeat(257) }), "client_secret"],
      [tokenBody(client, { scope: "" }), "scope"],
      [tokenBody(client, { scope: "Users:Read" }), "scope"],
      [tokenBody(client, { scope: `users:${"a".repeat(260)}` }), "scope"],
      [tokenBody(client, { audience: "care" }), "audience"],
      [tokenBody(client, { audience: `vcare-${"a".repeat(70)}` }), "audience"],
      [tokenBody(client, { role: "admin" }), "role"],
    ];

    for (const [body, field] of cases) {
      const response = await postToken(apps.internalApp, body);

      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, "ValidationFailed");
      const details = (response.body as { error: { details: { field: string }[] } }).error.details;
      expect(details.map((detail) => detail.field)).toContain(field);
    }
    expectContractDeclares(OPERATION, "post", 400, "ValidationFailed");
  });

  it("should return 400 and never echo the submitted secret when client_secret is invalid", async () => {
    const client = await seedServiceClient();

    const response = await postToken(apps.internalApp, tokenBody(client, { client_secret: "short-secret-value" }));

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain("short-secret-value");
  });

  it("should return 400 when a form key is repeated, the body is malformed JSON or the content type is unsupported", async () => {
    const client = await seedServiceClient();

    const repeated = await postTokenForm(apps.internalApp, {
      grant_type: "client_credentials",
      client_id: client.clientId,
      client_secret: client.secret,
      scope: ["users:read", "users:status:write"],
      audience: "vcare-identity",
    });
    const malformed = await request(apps.internalApp)
      .post(OPERATION)
      .set("Content-Type", "application/json")
      .send('{"grant_type": ');
    const plain = await request(apps.internalApp)
      .post(OPERATION)
      .set("Content-Type", "text/plain")
      .send("grant_type=client_credentials");

    for (const response of [repeated, malformed, plain]) {
      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, "ValidationFailed");
    }
  });
});

describe("POST /internal/auth/token: last_used_at", () => {
  it("should set last_used_at once, not move it within a minute and move it after a minute when the clock advances", async () => {
    const time = mutableClock(new Date("2026-10-07T10:00:00.000Z"));
    const { internalApp } = buildTestApps({ overrides: { clock: time.clock } });
    const client = await seedServiceClient();
    expect(await lastUsedAt(client.id)).toBeNull();

    await postToken(internalApp, tokenBody(client)).expect(200);
    const first = await waitForLastUsed(client.id);
    time.advance(30_000);
    await postToken(internalApp, tokenBody(client)).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const withinMinute = await lastUsedAt(client.id);
    time.advance(60_000);
    await postToken(internalApp, tokenBody(client)).expect(200);
    const afterMinute = await waitForLastUsed(client.id, new Date("2026-10-07T10:01:30.000Z"));

    expect(first?.toISOString()).toBe("2026-10-07T10:00:00.000Z");
    expect(withinMinute?.toISOString()).toBe("2026-10-07T10:00:00.000Z");
    expect(afterMinute?.toISOString()).toBe("2026-10-07T10:01:30.000Z");
  });

  it("should leave last_used_at untouched when the exchange fails", async () => {
    const client = await seedServiceClient();

    await postToken(apps.internalApp, tokenBody(client, { client_secret: "q".repeat(43) })).expect(401);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await lastUsedAt(client.id)).toBeNull();
  });
});

describe("POST /internal/auth/token: privacy", () => {
  it("should never write the secret, a hash or the issued token to the logs or any response body", async () => {
    const client = await seedServiceClient();
    const otherSecret = "w".repeat(43);
    const row = await db("service_clients").where("id", client.id).first<{ client_secret_hash: string }>();
    const logs = captureLogs({ level: "debug" });
    const bodies: string[] = [];
    let token = "";

    try {
      const ok = await postToken(apps.internalApp, tokenBody(client));
      const wrong = await postToken(apps.internalApp, tokenBody(client, { client_secret: otherSecret }));
      const forbidden = await postToken(apps.internalApp, tokenBody(client, { scope: "doctors:read" }));
      const invalid = await postToken(apps.internalApp, tokenBody(client, { client_secret: "short" }));
      bodies.push(...[ok, wrong, forbidden, invalid].map((response) => JSON.stringify(response.body)));
      token = (ok.body as { data: TokenData }).data.access_token;
    } finally {
      logs.restore();
    }

    const logText = logs.text();
    expect(logText.length).toBeGreaterThan(0);
    for (const secretValue of [client.secret, otherSecret, row?.client_secret_hash ?? "missing", token]) {
      expect(logText).not.toContain(secretValue);
    }
    for (const body of bodies.slice(1)) {
      expect(body).not.toContain(client.secret);
      expect(body).not.toContain(token);
      expect(body).not.toContain("$argon2");
    }
    expect(logs.lines().filter((line) => line.message === "service_token_denied").map((line) => line.reason)).toEqual(
      expect.arrayContaining(["bad_secret", "scope"]),
    );
  });
});

describe("POST /internal/auth/token: infrastructure failure", () => {
  it("should return the 500 InternalError envelope without internals when the database is unreachable", async () => {
    const unreachable = knex(
      buildKnexConfig({
        databaseUrl: "postgres://identity:identity@127.0.0.1:5999/vcare_identity_test",
        poolMax: 1,
        statementTimeoutMs: 2000,
      }),
    );
    try {
      const { internalApp } = buildTestApps({ overrides: { db: unreachable } });

      const response = await postToken(internalApp, tokenBody({ id: 0, clientId: "care-service", secret: "s".repeat(43) }));

      expect(response.status).toBe(500);
      expectErrorEnvelope(response.body, "InternalError");
      expect(JSON.stringify(response.body)).not.toMatch(/ECONNREFUSED|5999|knex|postgres/i);
    } finally {
      await unreachable.destroy();
    }
  });
});
