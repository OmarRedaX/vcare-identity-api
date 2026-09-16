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

    expect(output.message).toBe("boom");
    expect(output.stack).toBeUndefined();
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
});
