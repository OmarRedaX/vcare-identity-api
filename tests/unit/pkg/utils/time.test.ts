import { addTime, toMs } from "../../../../src/pkg/utils/time";

describe("toMs", () => {
  it("should convert each unit to milliseconds when toMs is called", () => {
    expect(toMs(1, "ms")).toBe(1);
    expect(toMs(2, "s")).toBe(2000);
    expect(toMs(3, "m")).toBe(180_000);
    expect(toMs(24, "h")).toBe(86_400_000);
    expect(toMs(2, "d")).toBe(172_800_000);
  });

  it("should throw RangeError when the amount is negative or not finite", () => {
    expect(() => toMs(-1, "s")).toThrow(RangeError);
    expect(() => toMs(Number.NaN, "s")).toThrow(RangeError);
    expect(() => toMs(Number.POSITIVE_INFINITY, "s")).toThrow(RangeError);
  });
});

describe("addTime", () => {
  it("should return a new Date when addTime is called", () => {
    const base = new Date("2026-09-16T10:00:00.000Z");
    const later = addTime(base, 90, "m");

    expect(later).not.toBe(base);
    expect(base.toISOString()).toBe("2026-09-16T10:00:00.000Z");
    expect(later.toISOString()).toBe("2026-09-16T11:30:00.000Z");
  });
});
