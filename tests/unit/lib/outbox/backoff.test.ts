import { retryDelaySeconds } from "../../../../src/lib/outbox/backoff";

describe("retryDelaySeconds", () => {
  it("should double from 30 seconds when the attempt count grows", () => {
    expect([1, 2, 3, 4, 5].map((attempts) => retryDelaySeconds(attempts))).toEqual([
      30, 60, 120, 240, 480,
    ]);
  });

  it("should cap at one hour when the attempt count is high", () => {
    expect(retryDelaySeconds(8)).toBe(3600);
    expect(retryDelaySeconds(20)).toBe(3600);
  });

  it("should return the base delay when the attempt count is below one", () => {
    expect(retryDelaySeconds(0)).toBe(30);
    expect(retryDelaySeconds(-5)).toBe(30);
  });
});
