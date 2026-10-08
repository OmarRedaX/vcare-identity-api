import type { Express } from "express";
import request from "supertest";
import { registerDependencies } from "../../../src/bootstrap";
import { createInternalApp } from "../../../src/internal-app";
import { buildInternalRouter } from "../../../src/internal-routes";
import { db } from "../../../src/lib/knex/knex";
import { serviceGuard } from "../../../src/lib/auth/service-guard";
import { assertRoutesAuthorized } from "../../../src/lib/rbac/assert-routes-authorized";
import { buildTestApps } from "../../helpers/app";
import { seedUser } from "../../helpers/auth";
import { expectContractDeclares, expectErrorEnvelope } from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { captureLogs } from "../../helpers/log-capture";
import { buildSigningKeySet } from "../../helpers/keys";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import { postToken, seedServiceClient, tokenBody } from "../../helpers/service-clients";
import {
  signAccessToken,
  signCustomServiceToken,
  signServiceTypedToken,
  tamperToken,
  unsignedServiceToken,
} from "../../helpers/tokens";
import { buildInternalProbeRouter } from "../../helpers/test-routers";

const READ = "/internal/__test/read";
const WRITE = "/internal/__test/write";

let internalApp: Express;
let publicApp: Express;
let scope: ReturnType<typeof registerDependencies>;

beforeAll(() => {
  scope = registerDependencies();
  internalApp = createInternalApp({ scope, extraInternalRouter: buildInternalProbeRouter(scope) });
  publicApp = buildTestApps().publicApp;
});

beforeEach(async () => {
  await truncateAll();
  await flushTestKeys();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function read(token?: string): request.Test {
  const call = request(internalApp).get(READ);
  return token === undefined ? call : call.set("Authorization", `Bearer ${token}`);
}

function expectServiceTokenRequired(response: request.Response): void {
  expect(response.status).toBe(401);
  expectErrorEnvelope(response.body, "ServiceTokenRequired");
}

describe("serviceGuard: authentication", () => {
  it("should answer 401 ServiceTokenRequired when no Authorization header or a malformed one is sent", async () => {
    expectServiceTokenRequired(await read());
    expectServiceTokenRequired(await request(internalApp).get(READ).set("Authorization", "Bearer"));
    expectServiceTokenRequired(await request(internalApp).get(READ).set("Authorization", "Basic Y2FyZTpzZWNyZXQ="));
    expectServiceTokenRequired(await read("not-a-jwt"));
    expectContractDeclares("/internal/users", "get", 401, "ServiceTokenRequired");
  });

  it("should answer 401 ServiceTokenRequired when a user token of any role is presented, an admin's included", async () => {
    for (const role of ["patient", "doctor", "admin"] as const) {
      const user = await seedUser({ email: `${role}.guard@example.test`, role, status: "active" });

      expectServiceTokenRequired(await read(await signAccessToken(user)));
    }
  });

  it("should answer 401 ServiceTokenRequired when the token is tampered, unsigned or signed by an unknown key", async () => {
    const valid = await signCustomServiceToken();
    const otherKeys = buildSigningKeySet(["not-published"]);

    expectServiceTokenRequired(await read(tamperToken(valid)));
    expectServiceTokenRequired(await read(unsignedServiceToken()));
    expectServiceTokenRequired(await read(await signCustomServiceToken({ keys: otherKeys })));
  });

  it("should answer 401 ServiceTokenRequired when the issuer, type, audience or claims are wrong", async () => {
    const defects = [
      { issuer: "someone-else" },
      { typ: "user" },
      { audience: "vcare-care" },
      { audience: ["vcare-care", "vcare-ai"] },
      { scope: null },
      { subject: "Not A Client" },
    ];

    for (const defect of defects) {
      expectServiceTokenRequired(await read(await signCustomServiceToken(defect)));
    }
  });

  it("should answer 401 ServiceTokenRequired for an expired token and accept one inside the 30 second skew", async () => {
    const expired = await signCustomServiceToken({ issuedAt: nowSeconds() - 600, expiresAt: nowSeconds() - 120 });
    const withinSkew = await signCustomServiceToken({ issuedAt: nowSeconds() - 600, expiresAt: nowSeconds() - 10 });

    expectServiceTokenRequired(await read(expired));
    expect((await read(withinSkew)).status).toBe(200);
  });

  it("should accept a string audience and an audience array that includes vcare-identity", async () => {
    const asString = await signCustomServiceToken({ audience: "vcare-identity" });
    const asArray = await signCustomServiceToken({ audience: ["vcare-care", "vcare-identity"] });

    expect((await read(asString)).status).toBe(200);
    expect((await read(asArray)).status).toBe(200);
  });

  it("should authenticate by the token alone when identity headers are spoofed", async () => {
    const token = await signCustomServiceToken({ subject: "care-service" });

    const withoutToken = await request(internalApp)
      .get(READ)
      .set("X-User-Id", "1")
      .set("X-Role", "admin")
      .set("X-Forwarded-User", "admin");
    const withToken = await read(token).set("X-User-Id", "1").set("X-Role", "admin").set("X-Forwarded-User", "admin");

    expectServiceTokenRequired(withoutToken);
    expect(withToken.status).toBe(200);
    expect((withToken.body as { data: { clientId: string } }).data.clientId).toBe("care-service");
  });

  it("should put the verified clientId on the request log line when a token is accepted", async () => {
    const token = await signCustomServiceToken({ subject: "care-service" });
    const logs = captureLogs({ level: "info" });

    try {
      await read(token);
    } finally {
      logs.restore();
    }

    const completed = logs.lines().find((line) => line.message === "request_completed");
    expect(completed).toMatchObject({ clientId: "care-service", status: 200 });
  });

  it("should never log the bearer token or any claim of an unverified token when it is refused", async () => {
    const tampered = tamperToken(await signCustomServiceToken({ subject: "claimed-client" }));
    const logs = captureLogs({ level: "debug" });

    try {
      await read(tampered);
    } finally {
      logs.restore();
    }

    expect(logs.text()).not.toContain(tampered);
    expect(logs.text()).not.toContain("claimed-client");
    expect(logs.lines().find((line) => line.message === "service_token_denied")).toMatchObject({
      reason: "bad_signature",
    });
  });
});

describe("authorize: service policy kind", () => {
  it("should answer 403 InsufficientScope when the token lacks the route's scope", async () => {
    const token = await signCustomServiceToken({ scope: "users:read" });

    const response = await request(internalApp).patch(WRITE).set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, "InsufficientScope");
    expectContractDeclares("/internal/users", "get", 403, "InsufficientScope");
  });

  it("should answer 200 with the principal when the token carries the route's scope", async () => {
    const token = await signCustomServiceToken({ scope: "users:read users:status:write" });

    const readResponse = await read(token);
    const writeResponse = await request(internalApp).patch(WRITE).set("Authorization", `Bearer ${token}`);

    expect(readResponse.status).toBe(200);
    expect(writeResponse.status).toBe(200);
    expect((readResponse.body as { data: { scopes: string[] } }).data.scopes).toEqual([
      "users:read",
      "users:status:write",
    ]);
  });
});

describe("service tokens across listeners and clients", () => {
  it("should answer 401 Unauthorized when a service token is used on a public /api route", async () => {
    const response = await request(publicApp)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${await signServiceTypedToken()}`);

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, "Unauthorized");
  });

  it("should keep honouring a token issued before its client was disabled until it expires while new exchanges fail", async () => {
    const client = await seedServiceClient();
    const issued = await postToken(internalApp, tokenBody(client)).expect(200);
    const token = (issued.body as { data: { access_token: string } }).data.access_token;

    await db("service_clients").where("id", client.id).update({ is_active: false });
    const stillValid = await read(token);
    const newExchange = await postToken(internalApp, tokenBody(client));

    expect(stillValid.status).toBe(200);
    expect(newExchange.status).toBe(401);
    expectErrorEnvelope(newExchange.body, "InvalidCredentials");
  });
});

describe("fail-closed boot check on the internal router", () => {
  it("should accept the real internal router when every route declares a policy", () => {
    expect(() => {
      assertRoutesAuthorized(buildInternalRouter(scope), "/internal");
    }).not.toThrow();
  });

  it("should refuse to start when a route is added to the internal router without authorize()", () => {
    const router = buildInternalRouter(scope);
    router.post("/unguarded", (_req, res) => {
      res.status(200).end();
    });
    const guardOnly = buildInternalRouter(scope);
    guardOnly.get(
      "/guard-only",
      serviceGuard({ keys: buildSigningKeySet(["k"]), clock: { now: () => new Date() } }),
      (_req, res) => {
        res.status(200).end();
      },
    );

    expect(() => {
      assertRoutesAuthorized(router, "/internal");
    }).toThrow("route_without_policy: POST /internal/unguarded");
    expect(() => {
      assertRoutesAuthorized(guardOnly, "/internal");
    }).toThrow("route_without_policy: GET /internal/guard-only");
  });
});
