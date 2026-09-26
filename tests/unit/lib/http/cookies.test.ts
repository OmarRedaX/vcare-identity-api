import type { Request, Response } from "express";
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
} from "../../../../src/lib/auth/constants";
import {
  clearRefreshCookie,
  readCookie,
  readRefreshCookie,
  setRefreshCookie,
} from "../../../../src/lib/http/cookies";

function requestWith(cookieHeader?: string): Request {
  return { headers: cookieHeader === undefined ? {} : { cookie: cookieHeader } } as Request;
}

function responseSpy(): { res: Response; header: () => string | undefined } {
  let value: string | undefined;
  const res = {
    setHeader: (name: string, headerValue: string) => {
      if (name === "Set-Cookie") {
        value = headerValue;
      }
    },
  } as unknown as Response;
  return { res, header: () => value };
}

const TOKEN = "kq3V0bXhZr9m1p2Yc8wS4tL7nA6eD5fG0hJ2iK3lM9o";

describe("readCookie", () => {
  it("should return the value when the named cookie is present", () => {
    expect(readRefreshCookie(requestWith(`${REFRESH_COOKIE_NAME}=${TOKEN}`))).toBe(TOKEN);
  });

  it("should find the cookie among others and ignore surrounding whitespace", () => {
    const header = `theme=dark; ${REFRESH_COOKIE_NAME}=${TOKEN} ; other=1`;

    expect(readRefreshCookie(requestWith(header))).toBe(TOKEN);
  });

  it("should return undefined when there is no Cookie header, an empty one, or no match", () => {
    expect(readRefreshCookie(requestWith())).toBeUndefined();
    expect(readRefreshCookie(requestWith(""))).toBeUndefined();
    expect(readRefreshCookie(requestWith("other=1"))).toBeUndefined();
  });

  it("should not confuse a cookie whose name merely ends with the wanted name", () => {
    expect(readRefreshCookie(requestWith(`not_${REFRESH_COOKIE_NAME}=${TOKEN}`))).toBeUndefined();
  });

  it("should return the first value when the same cookie name appears twice", () => {
    const header = `${REFRESH_COOKIE_NAME}=first; ${REFRESH_COOKIE_NAME}=second`;

    expect(readRefreshCookie(requestWith(header))).toBe("first");
  });

  it("should decode a percent-encoded value and return a malformed one as sent", () => {
    expect(readCookie(requestWith("x=a%20b"), "x")).toBe("a b");
    expect(readCookie(requestWith("x=%E0%A4%A"), "x")).toBe("%E0%A4%A");
  });

  it("should ignore a segment without a value when it precedes the cookie", () => {
    expect(readRefreshCookie(requestWith(`=novalue; ${REFRESH_COOKIE_NAME}=${TOKEN}`))).toBe(TOKEN);
  });
});

describe("setRefreshCookie and clearRefreshCookie", () => {
  it("should write exactly the contract's Set-Cookie attributes when a token is issued", () => {
    const spy = responseSpy();

    setRefreshCookie(spy.res, TOKEN);

    expect(spy.header()).toBe(
      `${REFRESH_COOKIE_NAME}=${TOKEN}; HttpOnly; Secure; SameSite=Strict; Path=${REFRESH_COOKIE_PATH}; Max-Age=${String(REFRESH_TOKEN_TTL_SECONDS)}`,
    );
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(2_592_000);
    expect(REFRESH_COOKIE_PATH).toBe("/api/auth");
  });

  it("should write the clearing cookie with Max-Age=0 when the session ends", () => {
    const spy = responseSpy();

    clearRefreshCookie(spy.res);

    expect(spy.header()).toBe(
      `${REFRESH_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=${REFRESH_COOKIE_PATH}; Max-Age=0`,
    );
  });
});
