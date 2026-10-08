import { AppError } from "../../../../src/lib/error/AppError";
import { REDACTED, REDACTED_KEYS, redact } from "../../../../src/lib/logger/redact";

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe("redact", () => {
  it("should redact every listed key when it appears at any depth", () => {
    const input: Record<string, unknown> = { outer: { inner: {} } };
    const leaf = asRecord(asRecord(input.outer).inner);
    for (const key of REDACTED_KEYS) {
      leaf[key] = "fixture-secret-value";
    }

    const output = asRecord(asRecord(asRecord(redact(input)).outer).inner);

    for (const key of REDACTED_KEYS) {
      expect(output[key]).toBe(REDACTED);
    }
    expect(JSON.stringify(output)).not.toContain("fixture-secret-value");
  });

  it("should match keys regardless of case dashes and underscores", () => {
    const output = asRecord(
      redact({
        Access_Token: "fixture-token",
        "REFRESH-TOKEN": "fixture-token",
        FullName: "Fixture Person",
        Email: "person@example.test",
        keep: "visible",
      }),
    );

    expect(output.Access_Token).toBe(REDACTED);
    expect(output["REFRESH-TOKEN"]).toBe(REDACTED);
    expect(output.FullName).toBe(REDACTED);
    expect(output.Email).toBe(REDACTED);
    expect(output.keep).toBe("visible");
  });

  it("should redact values inside arrays of objects", () => {
    const output = redact({ users: [{ email: "a@example.test" }, { email: "b@example.test" }] });

    expect(JSON.stringify(output)).not.toContain("@example.test");
    expect(output).toEqual({ users: [{ email: REDACTED }, { email: REDACTED }] });
  });

  it("should serialise errors to name message and stack when an Error is passed", () => {
    const err = new AppError("Conflict", 409, "boom");
    const output = asRecord(asRecord(redact({ err }, true)).err);

    expect(output.name).toBe("AppError");
    expect(output.message).toBe("boom");
    expect(output.code).toBe("Conflict");
    expect(typeof output.stack).toBe("string");
  });

  it("should omit the stack when the level does not include it", () => {
    const output = asRecord(asRecord(redact({ err: new Error("boom") }, false)).err);

    expect(output.message).toBe("error:Error");
    expect(output.stack).toBeUndefined();
  });

  it("should not log the message or stack header of an unknown error when it embeds a value", () => {
    const err = new Error("db password=synthetic-value");
    const output = JSON.stringify(redact({ err }, true));

    expect(output).not.toContain("synthetic-value");
  });

  it("should replace a driver error message with its SQLSTATE when it carries the offending input", () => {
    const err = Object.assign(
      new Error('select "id" from "t" where "family_id" = $1 - invalid input syntax for type uuid: "person@example.test"'),
      { code: "22P02", routine: "string_to_uuid" },
    );
    const output = asRecord(asRecord(redact({ err }, true)).err);

    expect(output.message).toBe("pg_error:22P02");
    expect(output.routine).toBe("string_to_uuid");
    expect(JSON.stringify(output)).not.toContain("person@example.test");
  });

  it("should replace a circular reference with a marker when redacting", () => {
    const input: Record<string, unknown> = { name: "root" };
    input.self = input;

    expect(redact(input)).toEqual({ name: "root", self: "[Circular]" });
  });

  it("should truncate when the value is nested deeper than eight levels", () => {
    let deep: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 12; i += 1) {
      deep = { nested: deep };
    }

    expect(JSON.stringify(redact(deep))).toContain("[Truncated]");
  });

  it("should not mutate the input when redacting", () => {
    const input = { password: "fixture-password", nested: { email: "person@example.test" } };

    redact(input);

    expect(input.password).toBe("fixture-password");
    expect(input.nested.email).toBe("person@example.test");
  });

  it("should stringify bigints and drop functions when redacting", () => {
    const output = asRecord(redact({ big: 10n, fn: () => undefined, keep: 1 }));

    expect(output.big).toBe("10");
    expect("fn" in output).toBe(false);
    expect(output.keep).toBe(1);
  });

  it("should redact the current and previous service client secret hashes in any casing", () => {
    const output = asRecord(
      redact({ clientSecretHash: "h1", previousSecretHash: "h2", previous_secret_hash: "h3", keep: 1 }),
    );

    expect(output.clientSecretHash).toBe(REDACTED);
    expect(output.previousSecretHash).toBe(REDACTED);
    expect(output.previous_secret_hash).toBe(REDACTED);
    expect(output.keep).toBe(1);
  });
});
