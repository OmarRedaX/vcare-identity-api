import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min, ValidateNested } from "class-validator";
import { AppError } from "../../../../src/lib/error/AppError";
import type { ErrorDetail } from "../../../../src/lib/error/types";
import { PaginationQueryDto } from "../../../../src/lib/http/pagination/pagination-query.dto";
import { validateBody, validateQuery } from "../../../../src/lib/validation/validate";

class AddressDto {
  @IsString()
  city!: string;
}

class PersonDto {
  @IsString()
  name!: string;

  @IsInt()
  @Min(1)
  @Max(120)
  age!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;
}

class FilterDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

async function detailsOf(run: () => Promise<unknown>): Promise<ErrorDetail[]> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const error = err as AppError;
    expect(error.code).toBe("ValidationFailed");
    expect(error.status).toBe(400);
    return [...error.details];
  }
  throw new Error("expected validation to fail");
}

describe("validateBody", () => {
  it("should return a typed instance when the body is valid", async () => {
    const dto = await validateBody(PersonDto, { name: "Fixture", age: 30 });

    expect(dto).toBeInstanceOf(PersonDto);
    expect(dto.name).toBe("Fixture");
    expect(dto.age).toBe(30);
  });

  it("should throw ValidationFailed with one detail per failing field when validation fails", async () => {
    const details = await detailsOf(() => validateBody(PersonDto, { name: 5, age: 0 }));

    expect(details.map((detail) => detail.field).sort()).toEqual(["age", "name"]);
    expect(details.every((detail) => detail.issue.length > 0)).toBe(true);
  });

  it("should report is not allowed when an unknown property is sent", async () => {
    const details = await detailsOf(() =>
      validateBody(PersonDto, { name: "Fixture", age: 30, role: "admin" }),
    );

    expect(details).toContainEqual({ field: "role", issue: "is not allowed" });
  });

  it("should reject the body when it is an array or null", async () => {
    expect(await detailsOf(() => validateBody(PersonDto, []))).toEqual([
      { field: "body", issue: "must be a JSON object" },
    ]);
    expect(await detailsOf(() => validateBody(PersonDto, null))).toEqual([
      { field: "body", issue: "must be a JSON object" },
    ]);
    expect(await detailsOf(() => validateBody(PersonDto, "text"))).toEqual([
      { field: "body", issue: "must be a JSON object" },
    ]);
  });

  it("should use dotted field paths when nested validation fails", async () => {
    const details = await detailsOf(() =>
      validateBody(PersonDto, { name: "Fixture", age: 30, address: { city: 7 } }),
    );

    expect(details.map((detail) => detail.field)).toContain("address.city");
  });

  it("should not convert a numeric string when validating a body", async () => {
    const details = await detailsOf(() => validateBody(PersonDto, { name: "Fixture", age: "30" }));

    expect(details.map((detail) => detail.field)).toEqual(["age"]);
  });
});

describe("validateQuery", () => {
  it("should convert numeric strings when validating a query", async () => {
    const dto = await validateQuery(FilterDto, { limit: "25" });

    expect(dto.limit).toBe(25);
  });

  it("should treat an undefined query as empty when validating", async () => {
    const dto = await validateQuery(FilterDto, undefined);

    expect(dto.limit).toBeUndefined();
  });

  it("should apply limit 20 when PaginationQueryDto receives no limit", async () => {
    const dto = await validateQuery(PaginationQueryDto, {});

    expect(dto.limit).toBe(20);
    expect(dto.cursor).toBeUndefined();
  });

  it("should reject a limit above 100 when PaginationQueryDto is validated", async () => {
    const details = await detailsOf(() => validateQuery(PaginationQueryDto, { limit: "101" }));

    expect(details.map((detail) => detail.field)).toEqual(["limit"]);
  });
});
