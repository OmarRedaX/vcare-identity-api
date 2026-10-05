import {
  ChangePasswordRequestDto,
  ForgotPasswordRequestDto,
  LoginRequestDto,
  RegisterCompleteRequestDto,
  RegisterStartRequestDto,
  ResetPasswordRequestDto,
  UpdateMeRequestDto,
} from "../../../../src/app/auth/dto/auth.request.dto";
import { AppError } from "../../../../src/lib/error/AppError";
import type { ErrorDetail } from "../../../../src/lib/error/types";
import { PASSWORD_DENYLIST } from "../../../../src/lib/password/denylist";
import { validateBody } from "../../../../src/lib/validation/validate";
import type { ClassType } from "../../../../src/lib/validation/types";

const VALID_PASSWORD = "Synthetic-Passw0rd";

const VALID_COMPLETE = {
  email: "amira.patient@example.test",
  code: "123456",
  password: VALID_PASSWORD,
  fullName: "Amira Hassan",
  role: "patient",
  timezone: "Africa/Cairo",
  locale: "ar-EG",
};

async function detailsOf<T extends object>(dto: ClassType<T>, body: unknown): Promise<ErrorDetail[]> {
  try {
    await validateBody(dto, body);
    throw new Error("expected validation to fail");
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ValidationFailed");
    return [...(err as AppError).details];
  }
}

function issueFor(details: readonly ErrorDetail[], field: string): string | undefined {
  return details.find((detail) => detail.field === field)?.issue;
}

describe("RegisterStartRequestDto", () => {
  it("should trim the email when it is submitted with whitespace", async () => {
    const dto = await validateBody(RegisterStartRequestDto, { email: "  Amira@Example.test " });

    expect(dto.email).toBe("Amira@Example.test");
  });

  it("should reject a malformed, over-long, or missing email", async () => {
    expect(issueFor(await detailsOf(RegisterStartRequestDto, { email: "nope" }), "email")).toBeDefined();
    expect(
      issueFor(await detailsOf(RegisterStartRequestDto, { email: `${"a".repeat(250)}@example.test` }), "email"),
    ).toBeDefined();
    expect(issueFor(await detailsOf(RegisterStartRequestDto, {}), "email")).toBeDefined();
  });

  it("should reject an unknown property when one is sent", async () => {
    const details = await detailsOf(RegisterStartRequestDto, {
      email: "amira.patient@example.test",
      role: "admin",
    });

    expect(issueFor(details, "role")).toBe("is not allowed");
  });

  it("should reject a body that is not a JSON object", async () => {
    expect(issueFor(await detailsOf(RegisterStartRequestDto, "string"), "body")).toBe(
      "must be a JSON object",
    );
    expect(issueFor(await detailsOf(RegisterStartRequestDto, []), "body")).toBe(
      "must be a JSON object",
    );
  });
});

describe("RegisterCompleteRequestDto", () => {
  it("should canonicalise the timezone and locale when they are valid", async () => {
    const dto = await validateBody(RegisterCompleteRequestDto, {
      ...VALID_COMPLETE,
      timezone: "africa/cairo",
      locale: "ar-eg",
    });

    expect(dto.timezone).toBe("Africa/Cairo");
    expect(dto.locale).toBe("ar-EG");
  });

  it("should accept a doctor and an optional E.164 phone when they are well formed", async () => {
    const dto = await validateBody(RegisterCompleteRequestDto, {
      ...VALID_COMPLETE,
      role: "doctor",
      phone: "+201000000001",
    });

    expect(dto.role).toBe("doctor");
    expect(dto.phone).toBe("+201000000001");
  });

  it("should reject role admin when registration is attempted for an admin", async () => {
    expect(issueFor(await detailsOf(RegisterCompleteRequestDto, { ...VALID_COMPLETE, role: "admin" }), "role")).toBeDefined();
  });

  it("should reject a code that is not exactly six digits", async () => {
    for (const code of ["12345", "1234567", "12345a", "", " 123456"]) {
      const details = await detailsOf(RegisterCompleteRequestDto, { ...VALID_COMPLETE, code });
      expect(issueFor(details, "code")).toBe("must be 6 digits");
    }
  });

  it("should reject a password shorter than 10 characters or on the denylist", async () => {
    const short = await detailsOf(RegisterCompleteRequestDto, { ...VALID_COMPLETE, password: "Short1!" });
    expect(issueFor(short, "password")).toBeDefined();

    const [common] = [...PASSWORD_DENYLIST];
    const denied = await detailsOf(RegisterCompleteRequestDto, { ...VALID_COMPLETE, password: common });
    expect(issueFor(denied, "password")).toBe("is too common");
  });

  it("should never echo the submitted password in a validation issue", async () => {
    const details = await detailsOf(RegisterCompleteRequestDto, {
      ...VALID_COMPLETE,
      password: "short",
    });

    expect(JSON.stringify(details)).not.toContain("short");
  });

  it("should reject a blank full name and a non-E.164 phone", async () => {
    expect(issueFor(await detailsOf(RegisterCompleteRequestDto, { ...VALID_COMPLETE, fullName: "   " }), "fullName")).toBeDefined();
    expect(issueFor(await detailsOf(RegisterCompleteRequestDto, { ...VALID_COMPLETE, phone: "01000000001" }), "phone")).toBe(
      "must be an E.164 phone number",
    );
  });

  it("should reject a null phone because the contract property is not nullable", async () => {
    expect(issueFor(await detailsOf(RegisterCompleteRequestDto, { ...VALID_COMPLETE, phone: null }), "phone")).toBeDefined();
  });

  it("should reject an invalid timezone or locale", async () => {
    expect(issueFor(await detailsOf(RegisterCompleteRequestDto, { ...VALID_COMPLETE, timezone: "Mars/Olympus" }), "timezone")).toBe(
      "must be a valid IANA time zone",
    );
    expect(issueFor(await detailsOf(RegisterCompleteRequestDto, { ...VALID_COMPLETE, locale: "not a locale" }), "locale")).toBe(
      "must be a valid BCP-47 language tag",
    );
  });
});

describe("timezone fixed offsets", () => {
  const OFFSETS = ["+01:00", "-05:00", "GMT+1", "01:00"];

  it.each(OFFSETS)("should reject %s on register/complete because it is not an IANA zone", async (timezone) => {
    expect(issueFor(await detailsOf(RegisterCompleteRequestDto, { ...VALID_COMPLETE, timezone }), "timezone")).toBe(
      "must be a valid IANA time zone",
    );
  });

  it.each(OFFSETS)("should reject %s on PATCH /auth/me because it is not an IANA zone", async (timezone) => {
    expect(issueFor(await detailsOf(UpdateMeRequestDto, { timezone }), "timezone")).toBe(
      "must be a valid IANA time zone",
    );
  });

  it("should accept UTC and a named zone on both DTOs", async () => {
    const registered = await validateBody(RegisterCompleteRequestDto, { ...VALID_COMPLETE, timezone: "UTC" });
    const patched = await validateBody(UpdateMeRequestDto, { timezone: "africa/cairo" });

    expect(registered.timezone).toBe("UTC");
    expect(patched.timezone).toBe("Africa/Cairo");
  });
});

describe("LoginRequestDto", () => {
  it("should accept any non-empty password when logging in, denylist included", async () => {
    const [common] = [...PASSWORD_DENYLIST];
    const dto = await validateBody(LoginRequestDto, {
      email: "amira.patient@example.test",
      password: common,
    });

    expect(dto.password).toBe(common);
  });

  it("should reject an empty password when logging in", async () => {
    expect(issueFor(await detailsOf(LoginRequestDto, { email: "a@example.test", password: "" }), "password")).toBeDefined();
  });
});

describe("ForgotPasswordRequestDto and ResetPasswordRequestDto", () => {
  it("should accept a well-formed reset request when the code is six digits", async () => {
    const dto = await validateBody(ResetPasswordRequestDto, {
      email: " amira.patient@example.test ",
      code: "000123",
      newPassword: VALID_PASSWORD,
    });

    expect(dto).toMatchObject({ email: "amira.patient@example.test", code: "000123" });
  });

  it("should reject a reset code that is not six digits before any service work", async () => {
    expect(issueFor(await detailsOf(ResetPasswordRequestDto, {
      email: "amira.patient@example.test",
      code: "12345",
      newPassword: VALID_PASSWORD,
    }), "code")).toBe("must be 6 digits");
  });

  it("should reject a denylisted or short new password on reset", async () => {
    const [common] = [...PASSWORD_DENYLIST];
    expect(issueFor(await detailsOf(ResetPasswordRequestDto, {
      email: "amira.patient@example.test",
      code: "123456",
      newPassword: common,
    }), "newPassword")).toBe("is too common");
    expect(issueFor(await detailsOf(ForgotPasswordRequestDto, { email: "nope" }), "email")).toBeDefined();
  });
});

describe("ChangePasswordRequestDto", () => {
  it("should accept any current password and a strong new one", async () => {
    const dto = await validateBody(ChangePasswordRequestDto, {
      currentPassword: "x",
      newPassword: VALID_PASSWORD,
    });

    expect(dto.newPassword).toBe(VALID_PASSWORD);
  });

  it("should reject a weak new password when it is on the denylist", async () => {
    const [common] = [...PASSWORD_DENYLIST];

    expect(issueFor(await detailsOf(ChangePasswordRequestDto, {
      currentPassword: "x",
      newPassword: common,
    }), "newPassword")).toBe("is too common");
  });
});

describe("UpdateMeRequestDto", () => {
  it("should accept a single provided field when only one is patched", async () => {
    const dto = await validateBody(UpdateMeRequestDto, { fullName: "  Amira Hassan  " });

    expect(dto.fullName).toBe("Amira Hassan");
    expect(dto.phone).toBeUndefined();
  });

  it("should accept null for phone and avatarUrl when they are cleared", async () => {
    const dto = await validateBody(UpdateMeRequestDto, { phone: null, avatarUrl: null });

    expect(dto.phone).toBeNull();
    expect(dto.avatarUrl).toBeNull();
  });

  it("should reject an empty body when nothing is patched", async () => {
    expect(issueFor(await detailsOf(UpdateMeRequestDto, {}), "body")).toBe(
      "must contain at least one property",
    );
  });

  it("should reject email, role and status when they are sent", async () => {
    for (const field of ["email", "role", "status"]) {
      const details = await detailsOf(UpdateMeRequestDto, { fullName: "Amira", [field]: "x" });
      expect(issueFor(details, field)).toBe("is not allowed");
    }
  });

  it("should reject a null timezone, locale or fullName because only phone and avatarUrl are clearable", async () => {
    expect(issueFor(await detailsOf(UpdateMeRequestDto, { timezone: null }), "timezone")).toBeDefined();
    expect(issueFor(await detailsOf(UpdateMeRequestDto, { locale: null }), "locale")).toBeDefined();
    expect(issueFor(await detailsOf(UpdateMeRequestDto, { fullName: null }), "fullName")).toBeDefined();
  });

  it("should reject an avatar URL without an http or https scheme", async () => {
    expect(issueFor(await detailsOf(UpdateMeRequestDto, { avatarUrl: "ftp://example.test/a.png" }), "avatarUrl")).toBeDefined();
    expect(issueFor(await detailsOf(UpdateMeRequestDto, { avatarUrl: "/relative.png" }), "avatarUrl")).toBeDefined();
  });

  it("should accept an http URL without a top-level domain when it is a local avatar host", async () => {
    const dto = await validateBody(UpdateMeRequestDto, { avatarUrl: "http://localhost:9000/a.png" });

    expect(dto.avatarUrl).toBe("http://localhost:9000/a.png");
  });
});
