import { AppError } from "../../../../src/lib/error/AppError";
import { ValidationFailed } from "../../../../src/lib/error/errors";

describe("AppError", () => {
  it("should return a new instance with details when withDetails is called", () => {
    const withDetails = ValidationFailed.withDetails([{ field: "email", issue: "must be an email" }]);

    expect(withDetails).toBeInstanceOf(AppError);
    expect(withDetails).not.toBe(ValidationFailed);
    expect(withDetails.code).toBe("ValidationFailed");
    expect(withDetails.status).toBe(400);
    expect(withDetails.message).toBe(ValidationFailed.message);
    expect(withDetails.details).toEqual([{ field: "email", issue: "must be an email" }]);
  });

  it("should leave the shared instance unchanged when withDetails is called", () => {
    ValidationFailed.withDetails([{ field: "cursor", issue: "is invalid" }]);

    expect(ValidationFailed.details).toEqual([]);
  });
});
