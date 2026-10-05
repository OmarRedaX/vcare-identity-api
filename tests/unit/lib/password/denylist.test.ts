import { validate } from "class-validator";
import { PASSWORD_DENYLIST } from "../../../../src/lib/password/denylist";
import { IsAcceptablePassword } from "../../../../src/lib/password/is-acceptable-password";

class PasswordHolder {
  @IsAcceptablePassword()
  password!: string;

  constructor(password: string) {
    this.password = password;
  }
}

function firstDenylistEntry(): string {
  const [entry] = [...PASSWORD_DENYLIST];
  if (entry === undefined) {
    throw new Error("the denylist must not be empty");
  }
  return entry;
}

describe("PASSWORD_DENYLIST", () => {
  it("should hold only lower-case entries of 10..128 characters when loaded", () => {
    expect(PASSWORD_DENYLIST.size).toBeGreaterThan(100);
    for (const entry of PASSWORD_DENYLIST) {
      expect(entry).toBe(entry.toLowerCase());
      expect(entry.length).toBeGreaterThanOrEqual(10);
      expect(entry.length).toBeLessThanOrEqual(128);
    }
  });
});

describe("IsAcceptablePassword", () => {
  it("should reject a denylisted password with the issue 'is too common' when it is submitted", async () => {
    const errors = await validate(new PasswordHolder(firstDenylistEntry()));

    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0]?.constraints ?? {})).toEqual(["is too common"]);
  });

  it("should reject a denylisted password regardless of case", async () => {
    const entry = firstDenylistEntry();

    const errors = await validate(new PasswordHolder(entry.toUpperCase()));

    expect(errors).toHaveLength(1);
  });

  it("should accept a password that is not on the denylist", async () => {
    await expect(validate(new PasswordHolder("Unlisted-Synthetic-Passw0rd"))).resolves.toEqual([]);
  });

  it("should reject a non-string value when the property is not a string", async () => {
    const errors = await validate(new PasswordHolder(undefined as unknown as string));

    expect(errors).toHaveLength(1);
  });
});
