import fs from "node:fs";
import path from "node:path";
import express, { type ErrorRequestHandler, type Express } from "express";
import { SignJWT } from "jose";
import request from "supertest";
import { SERVICE_SCOPES, SERVICE_TOKEN_TTL_SECONDS } from "../../../../src/lib/auth/constants";
import { TokenSigner, verifyServiceAccessToken } from "../../../../src/lib/auth/jwt";
import { serviceGuard } from "../../../../src/lib/auth/service-guard";
import type { SigningKeySet } from "../../../../src/lib/auth/types";
import { AppError } from "../../../../src/lib/error/AppError";
import { Logger } from "../../../../src/lib/logger/logger";
import { getRequestContext, requestContext } from "../../../../src/lib/request-id/context";
import type { Clock } from "../../../../src/lib/time/types";
import { buildSigningKeySet } from "../../../helpers/keys";

const NOW = new Date("2026-10-07T10:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const clock: Clock = { now: () => NOW };

let keys: SigningKeySet;
let otherKeys: SigningKeySet;
let app: Express;
let contextClientId: string | undefined;
let written: string[];

// Express recognises an error handler by its arity, so the unused fourth parameter has to stay.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const renderError: ErrorRequestHandler = (err, _req, res, _next) => {
  const error = err as AppError;
  res.status(error.status).json({ code: error.code });
};

async function sign(
  claims: Record<string, unknown> = {},
  options: { audience?: string | string[]; issuer?: string; issuedAt?: number; expiresAt?: number; signer?: SigningKeySet } = {},
): Promise<string> {
  const signer = options.signer ?? keys;
  const issuedAt = options.issuedAt ?? NOW_SECONDS;
  return new SignJWT({ typ: "service", scope: "users:read", ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: signer.activeKid, typ: "JWT" })
    .setIssuer(options.issuer ?? "vcare-identity")
    .setAudience(options.audience ?? "vcare-identity")
    .setSubject("care-service")
    .setIssuedAt(issuedAt)
    .setExpirationTime(options.expiresAt ?? issuedAt + 300)
    .setJti("11111111-1111-4111-8111-111111111111")
    .sign(signer.signingKey);
}

function call(token?: string): request.Test {
  const test = request(app).get("/guarded");
  return token === undefined ? test : test.set("Authorization", `Bearer ${token}`);
}

beforeAll(() => {
  keys = buildSigningKeySet(["kid-service"]);
  otherKeys = buildSigningKeySet(["kid-other"]);
});

beforeEach(() => {
  contextClientId = undefined;
  written = [];
  const logger = new Logger({
    service: "identity-service",
    level: "debug",
    production: false,
    sink: (line) => {
      written.push(line);
    },
  });

  app = express();
  app.use((_req, _res, next) => {
    requestContext.run({ requestId: "11111111-1111-4111-8111-111111111111" }, () => {
      next();
    });
  });
  app.get("/guarded", serviceGuard({ keys, clock, logger }), (req, res) => {
    contextClientId = getRequestContext()?.clientId;
    res.status(200).json(req.auth);
  });
  app.use(renderError);
});

function reasons(): unknown[] {
  return written
    .join("")
    .split("\n")
    .filter((line) => line.includes('"service_token_denied"') && line.includes('"level":"warn"'))
    .map((line) => (JSON.parse(line) as { reason: unknown }).reason);
}

describe("TokenSigner.signServiceToken", () => {
  it("should sign the BR-7 claims with a string aud, a 300 second lifetime and the active kid", async () => {
    const token = await new TokenSigner(keys, clock).signServiceToken({
      clientId: "care-service",
      audience: "vcare-identity",
      scopes: ["users:read", "users:status:write"],
    });
    const [header, payload] = token.split(".").slice(0, 2).map(
      (part) => JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8")) as Record<string, unknown>,
    );

    expect(header).toEqual({ alg: "EdDSA", kid: "kid-service", typ: "JWT" });
    expect(payload).toMatchObject({
      iss: "vcare-identity",
      sub: "care-service",
      typ: "service",
      aud: "vcare-identity",
      scope: "users:read users:status:write",
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + SERVICE_TOKEN_TTL_SECONDS,
    });
    expect(SERVICE_TOKEN_TTL_SECONDS).toBe(300);
    expect(typeof payload?.jti).toBe("string");
    expect(Object.keys(payload ?? {}).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "scope", "sub", "typ"]);
  });

  it("should issue a token the verifier accepts when it is round-tripped", async () => {
    const token = await new TokenSigner(keys, clock).signServiceToken({
      clientId: "care-service",
      audience: "vcare-identity",
      scopes: ["users:read"],
    });

    await expect(verifyServiceAccessToken(token, keys, clock)).resolves.toEqual({
      ok: true,
      auth: { kind: "service", clientId: "care-service", scopes: ["users:read"] },
    });
  });
});

describe("serviceGuard", () => {
  it("should set req.auth and the context clientId when a valid service token is presented", async () => {
    const response = await call(await sign({ scope: "users:read users:status:write" }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      kind: "service",
      clientId: "care-service",
      scopes: ["users:read", "users:status:write"],
    });
    expect(contextClientId).toBe("care-service");
  });

  it("should answer 401 ServiceTokenRequired with the same body when the header is missing or malformed", async () => {
    for (const header of [undefined, "Bearer", "Basic abc", "bearer  two parts"]) {
      const test = request(app).get("/guarded");
      const response = await (header === undefined ? test : test.set("Authorization", header));

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ code: "ServiceTokenRequired" });
    }
    expect(reasons()).toEqual(["missing_token", "missing_token", "missing_token", "missing_token"]);
  });

  it("should log malformed, bad_signature and unknown_kid for the matching defects without echoing them", async () => {
    const valid = await sign();
    const tampered = `${valid.slice(0, -3)}${valid.endsWith("AAA") ? "BBB" : "AAA"}`;

    expect((await call("not-a-jwt")).status).toBe(401);
    expect((await call(tampered)).status).toBe(401);
    expect((await call(await sign({}, { signer: otherKeys }))).status).toBe(401);

    expect(reasons()).toEqual(["malformed", "bad_signature", "unknown_kid"]);
  });

  it("should refuse alg none and an HS256 token even when the claims are right", async () => {
    const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    const claims = {
      iss: "vcare-identity",
      sub: "care-service",
      aud: "vcare-identity",
      typ: "service",
      scope: "users:read",
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 300,
      jti: "x",
    };
    const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
    const hs256 = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", kid: "kid-service" })
      .sign(new TextEncoder().encode("k".repeat(32)));

    expect((await call(unsigned)).status).toBe(401);
    expect((await call(hs256)).status).toBe(401);
  });

  it("should refuse a wrong issuer, a user token type, a wrong audience and malformed claims", async () => {
    const cases: [Promise<string>, string][] = [
      [sign({}, { issuer: "someone-else" }), "bad_issuer"],
      [sign({ typ: "user" }), "wrong_type"],
      [sign({}, { audience: "vcare-care" }), "wrong_audience"],
      [sign({}, { audience: ["vcare-care", "vcare-ai"] }), "wrong_audience"],
      [sign({ scope: undefined }), "bad_claims"],
      [sign({ scope: ["users:read"] }), "bad_claims"],
    ];

    for (const [token] of cases) {
      expect((await call(await token)).status).toBe(401);
    }
    expect(reasons()).toEqual(cases.map(([, reason]) => reason));
  });

  it("should refuse a token past exp plus the 30 second skew and accept one inside it", async () => {
    const beyond = await sign({}, { issuedAt: NOW_SECONDS - 600, expiresAt: NOW_SECONDS - 31 });
    const inside = await sign({}, { issuedAt: NOW_SECONDS - 600, expiresAt: NOW_SECONDS - 29 });

    const refused = await call(beyond);
    const accepted = await call(inside);

    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ code: "ServiceTokenRequired" });
    expect(accepted.status).toBe(200);
    expect(reasons()).toEqual(["expired"]);
  });

  it("should refuse a correctly signed token that lacks exp, iat, sub or jti", async () => {
    const build = (omit: "exp" | "iat" | "sub" | "jti"): Promise<string> => {
      const jwt = new SignJWT({ typ: "service", scope: "users:read" })
        .setProtectedHeader({ alg: "EdDSA", kid: keys.activeKid, typ: "JWT" })
        .setIssuer("vcare-identity")
        .setAudience("vcare-identity");
      if (omit !== "sub") jwt.setSubject("care-service");
      if (omit !== "iat") jwt.setIssuedAt(NOW_SECONDS);
      if (omit !== "exp") jwt.setExpirationTime(NOW_SECONDS + 300);
      if (omit !== "jti") jwt.setJti("11111111-1111-4111-8111-111111111111");
      return jwt.sign(keys.signingKey);
    };

    for (const omit of ["exp", "iat", "sub", "jti"] as const) {
      const response = await call(await build(omit));
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ code: "ServiceTokenRequired" });
    }
    expect(reasons()).toEqual(["bad_claims", "bad_claims", "bad_claims", "bad_claims"]);
  });

  it("should accept an audience array that contains vcare-identity", async () => {
    expect((await call(await sign({}, { audience: ["vcare-care", "vcare-identity"] }))).status).toBe(200);
  });

  it("should ignore X-User-Id, X-Role and X-Forwarded-User entirely", async () => {
    const response = await call(await sign())
      .set("X-User-Id", "1")
      .set("X-Role", "admin")
      .set("X-Forwarded-User", "admin");
    const anonymous = await request(app).get("/guarded").set("X-User-Id", "1").set("X-Role", "admin");

    expect(response.body).toMatchObject({ kind: "service", clientId: "care-service" });
    expect(anonymous.status).toBe(401);
  });

  it("should not log a clientId for a token whose signature did not verify", async () => {
    await call(`${(await sign()).slice(0, -3)}AAA`);

    expect(written.join("")).not.toContain("care-service");
    expect(contextClientId).toBeUndefined();
  });

  it("should perform no I/O because the module imports neither the database nor Redis", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/lib/auth/service-guard.ts"), "utf8");

    expect(source).not.toMatch(/from "[^"]*(knex|redis|ioredis)[^"]*"/);
  });
});

describe("SERVICE_SCOPES", () => {
  it("should list exactly the three scopes the contract and CLAUDE.md define", () => {
    expect([...SERVICE_SCOPES]).toEqual(["users:read", "users:status:write", "doctors:read"]);
  });
});
