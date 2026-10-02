import {
  AccessTokenResponseDto,
  LoginResponseDto,
  UserResponseDto,
} from "../../../../src/app/auth/dto/auth.response.dto";
import { User } from "../../../../src/app/auth/entity/user.entity";
import { contractRequired } from "../../../helpers/contract";

const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA";

function user(overrides: Partial<User> = {}): User {
  return new User({
    id: 1042,
    email: "amira.patient@example.test",
    phone: "+201000000001",
    passwordHash: PASSWORD_HASH,
    fullName: "Amira Hassan",
    avatarUrl: null,
    role: "patient",
    status: "active",
    emailVerifiedAt: new Date("2026-09-17T09:00:00.000Z"),
    timezone: "Africa/Cairo",
    locale: "ar-EG",
    createdAt: new Date("2026-09-17T09:00:00.000Z"),
    updatedAt: new Date("2026-09-17T09:30:00.000Z"),
    deletedAt: null,
    ...overrides,
  });
}

describe("UserResponseDto", () => {
  it("should carry exactly the contract's User properties when a user is rendered", () => {
    const dto = UserResponseDto.from(user());

    expect(Object.keys(dto).sort()).toEqual([...contractRequired("User")].sort());
  });

  it("should never carry the password hash or deletedAt when a user is rendered", () => {
    const serialized = JSON.stringify(UserResponseDto.from(user({ deletedAt: new Date() })));

    expect(serialized).not.toContain(PASSWORD_HASH);
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("deletedAt");
  });

  it("should render dates as ISO-8601 UTC strings and nullable fields as null", () => {
    const dto = UserResponseDto.from(user({ phone: null, emailVerifiedAt: null }));

    expect(dto.createdAt).toBe("2026-09-17T09:00:00.000Z");
    expect(dto.updatedAt).toBe("2026-09-17T09:30:00.000Z");
    expect(dto.phone).toBeNull();
    expect(dto.avatarUrl).toBeNull();
    expect(dto.emailVerifiedAt).toBeNull();
  });
});

describe("AccessTokenResponseDto and LoginResponseDto", () => {
  it("should carry the contract's fixed token type and 900 second lifetime", () => {
    const dto = AccessTokenResponseDto.from("synthetic.access.token");

    expect(dto).toEqual({
      accessToken: "synthetic.access.token",
      tokenType: "Bearer",
      expiresIn: 900,
    });
    expect(Object.keys(dto).sort()).toEqual([...contractRequired("AccessTokenResponse")].sort());
  });

  it("should add the user to the token response when a login succeeds", () => {
    const dto = LoginResponseDto.from("synthetic.access.token", user());

    expect(Object.keys(dto).sort()).toEqual(
      [...contractRequired("AccessTokenResponse"), "user"].sort(),
    );
    expect(dto.user.id).toBe(1042);
  });

  it("should never carry a refresh token in the body when a login succeeds", () => {
    const serialized = JSON.stringify(LoginResponseDto.from("synthetic.access.token", user()));

    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("refresh_token");
  });
});
