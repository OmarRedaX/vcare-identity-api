import { ServiceTokenRequestDto } from "../../../../src/app/service-auth/dto/service-auth.request.dto";
import { ServiceTokenResponseDto } from "../../../../src/app/service-auth/dto/service-auth.response.dto";
import { validateBody } from "../../../../src/lib/validation/validate";

const VALID = {
  grant_type: "client_credentials",
  client_id: "care-service",
  client_secret: "s".repeat(43),
  scope: "users:read users:status:write",
  audience: "vcare-identity",
};

async function fieldsOf(body: unknown): Promise<string[]> {
  try {
    await validateBody(ServiceTokenRequestDto, body);
  } catch (err) {
    return (err as { details: { field: string }[] }).details.map((detail) => detail.field);
  }
  return [];
}

describe("ServiceTokenRequestDto", () => {
  it("should accept the contract's example request", async () => {
    await expect(validateBody(ServiceTokenRequestDto, VALID)).resolves.toMatchObject(VALID);
  });

  it("should reject a grant_type other than client_credentials", async () => {
    expect(await fieldsOf({ ...VALID, grant_type: "password" })).toEqual(["grant_type"]);
    expect(await fieldsOf({ ...VALID, grant_type: undefined })).toEqual(["grant_type"]);
  });

  it.each(["Care", "ab", "1care", "care_service", "a".repeat(65), "", "care service"])(
    "should reject client_id %p",
    async (clientId) => {
      expect(await fieldsOf({ ...VALID, client_id: clientId })).toEqual(["client_id"]);
    },
  );

  it("should enforce 32 to 256 characters on client_secret", async () => {
    expect(await fieldsOf({ ...VALID, client_secret: "s".repeat(31) })).toEqual(["client_secret"]);
    expect(await fieldsOf({ ...VALID, client_secret: "s".repeat(32) })).toEqual([]);
    expect(await fieldsOf({ ...VALID, client_secret: "s".repeat(256) })).toEqual([]);
    expect(await fieldsOf({ ...VALID, client_secret: "s".repeat(257) })).toEqual(["client_secret"]);
  });

  it.each(["", "users", "Users:read", "users:read  users:status:write", " users:read", "users:read ", "users:1"])(
    "should reject scope %p",
    async (scope) => {
      expect(await fieldsOf({ ...VALID, scope })).toEqual(["scope"]);
    },
  );

  it("should cap scope at 256 characters and audience at 64", async () => {
    const longScope = Array.from({ length: 40 }, () => "users:read").join(" ");
    expect(longScope.length).toBeGreaterThan(256);

    expect(await fieldsOf({ ...VALID, scope: longScope })).toEqual(["scope"]);
    expect(await fieldsOf({ ...VALID, audience: `vcare-${"a".repeat(58)}` })).toEqual([]);
    expect(await fieldsOf({ ...VALID, audience: `vcare-${"a".repeat(59)}` })).toEqual(["audience"]);
  });

  it.each(["care", "Vcare-identity", "vcare-", "vcare-Identity", "vcare identity"])(
    "should reject audience %p",
    async (audience) => {
      expect(await fieldsOf({ ...VALID, audience })).toEqual(["audience"]);
    },
  );

  it("should reject unknown properties", async () => {
    expect(await fieldsOf({ ...VALID, role: "admin" })).toEqual(["role"]);
  });

  it("should reject a repeated form key because it arrives as an array", async () => {
    expect(await fieldsOf({ ...VALID, client_id: ["care-service", "other-client"] })).toEqual(["client_id"]);
    expect(await fieldsOf({ ...VALID, scope: ["users:read", "users:status:write"] })).toEqual(["scope"]);
  });

  it("should accept a null-prototype body such as the form parser produces", async () => {
    const body: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, VALID);

    await expect(validateBody(ServiceTokenRequestDto, body)).resolves.toMatchObject({ client_id: "care-service" });
  });

  it("should not echo the submitted secret in any validation detail", async () => {
    const secret = "short-secret-value";

    let message = "";
    try {
      await validateBody(ServiceTokenRequestDto, { ...VALID, client_secret: secret });
    } catch (err) {
      message = JSON.stringify((err as { details: unknown }).details);
    }

    expect(message).not.toBe("");
    expect(message).not.toContain(secret);
  });

  it("should reject a body that is not an object", async () => {
    expect(await fieldsOf(undefined)).toEqual(["body"]);
    expect(await fieldsOf("grant_type=client_credentials")).toEqual(["body"]);
  });
});

describe("ServiceTokenResponseDto", () => {
  it("should expose exactly the four OAuth fields with a fixed Bearer type and 300 second lifetime", () => {
    const dto = ServiceTokenResponseDto.from({ accessToken: "synthetic.service.token", scope: "users:read" });

    expect(dto).toEqual({
      access_token: "synthetic.service.token",
      token_type: "Bearer",
      expires_in: 300,
      scope: "users:read",
    });
  });
});
