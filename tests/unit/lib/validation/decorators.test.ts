import { validate } from "class-validator";
import {
  canonicalLocale,
  canonicalTimeZone,
  IsBcp47Locale,
  IsIanaTimeZone,
  IsNotBlank,
  MinProperties,
  minPropertiesOf,
  resolveLocale,
  resolveTimeZone,
  trimmed,
} from "../../../../src/lib/validation/decorators";

class Holder {
  @IsIanaTimeZone()
  timezone: unknown;

  @IsBcp47Locale()
  locale: unknown;

  @IsNotBlank()
  fullName: unknown;

  constructor(timezone: unknown, locale: unknown, fullName: unknown) {
    this.timezone = timezone;
    this.locale = locale;
    this.fullName = fullName;
  }
}

async function issuesOf(holder: Holder): Promise<Record<string, string>> {
  const errors = await validate(holder);
  return Object.fromEntries(
    errors.map((error) => [error.property, Object.values(error.constraints ?? {})[0] ?? ""]),
  );
}

describe("IsIanaTimeZone and canonicalTimeZone", () => {
  it("should accept a canonical zone, an alias and UTC when they are valid IANA zones", () => {
    expect(resolveTimeZone("Africa/Cairo")).toBe("Africa/Cairo");
    expect(resolveTimeZone("UTC")).toBe("UTC");
    expect(resolveTimeZone("africa/cairo")).toBe("Africa/Cairo");
  });

  it("should reject fixed UTC offsets even though Intl accepts them", () => {
    for (const offset of ["+01:00", "-05:00", "GMT+1", "+0100"]) {
      expect(resolveTimeZone(offset)).toBeUndefined();
    }
    expect(resolveTimeZone("Etc/GMT+1")).toBe("Etc/GMT+1");
  });

  it("should canonicalise the stored value when the zone is written in another case", () => {
    expect(canonicalTimeZone("africa/cairo")).toBe("Africa/Cairo");
    expect(canonicalTimeZone("america/new_york")).toBe("America/New_York");
  });

  it("should leave an invalid value untouched so the validator can reject it", () => {
    expect(canonicalTimeZone("Mars/Olympus")).toBe("Mars/Olympus");
    expect(canonicalTimeZone(42)).toBe(42);
  });

  it("should reject a garbage zone with a message that never echoes the value", async () => {
    const issues = await issuesOf(new Holder("Mars/Olympus", "en-GB", "Amira"));

    expect(issues.timezone).toBe("must be a valid IANA time zone");
    expect(issues.timezone).not.toContain("Mars");
  });
});

describe("IsBcp47Locale and canonicalLocale", () => {
  it("should canonicalise a lower-case tag when it is valid", () => {
    expect(resolveLocale("ar-eg")).toBe("ar-EG");
    expect(canonicalLocale("ar-eg")).toBe("ar-EG");
    expect(canonicalLocale("EN")).toBe("en");
  });

  it("should reject an invalid tag with a message that never echoes the value", async () => {
    const issues = await issuesOf(new Holder("UTC", "not a locale", "Amira"));

    expect(issues.locale).toBe("must be a valid BCP-47 language tag");
    expect(issues.locale).not.toContain("not a locale");
  });
});

describe("IsNotBlank and trimmed", () => {
  it("should reject a whitespace-only value when it is submitted", async () => {
    const issues = await issuesOf(new Holder("UTC", "en", "   "));

    expect(issues.fullName).toBe("must not be blank");
  });

  it("should accept a value with surrounding whitespace once it is trimmed", () => {
    expect(trimmed("  Amira Hassan  ")).toBe("Amira Hassan");
    expect(trimmed(7)).toBe(7);
  });

  it("should accept a non-blank value when everything is valid", async () => {
    await expect(issuesOf(new Holder("Africa/Cairo", "ar-EG", "Amira"))).resolves.toEqual({});
  });
});

describe("MinProperties", () => {
  it("should record the minimum on the class when the decorator is applied", () => {
    @MinProperties(1)
    class Patch {}

    expect(minPropertiesOf(Patch)).toBe(1);
  });

  it("should return undefined when the class carries no rule or the target is not a class", () => {
    class Plain {}

    expect(minPropertiesOf(Plain)).toBeUndefined();
    expect(minPropertiesOf({})).toBeUndefined();
    expect(minPropertiesOf(undefined)).toBeUndefined();
  });
});
