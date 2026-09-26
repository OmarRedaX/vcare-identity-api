import { plainToInstance } from "class-transformer";
import { validate, type ValidationError } from "class-validator";
import { ValidationFailed } from "../error/errors";
import type { ErrorDetail } from "../error/types";
import { minPropertiesOf } from "./decorators";
import type { ClassType } from "./types";

const VALIDATOR_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
  validationError: { target: false, value: false },
} as const;

function toDetails(errors: readonly ValidationError[], parentPath = ""): ErrorDetail[] {
  const details: ErrorDetail[] = [];

  for (const error of errors) {
    const field = parentPath.length > 0 ? `${parentPath}.${error.property}` : error.property;
    const constraints = error.constraints;

    if (constraints) {
      const issue = "whitelistValidation" in constraints ? "is not allowed" : Object.values(constraints)[0];
      details.push({ field, issue: issue ?? "is invalid" });
    }

    if (error.children && error.children.length > 0) {
      details.push(...toDetails(error.children, field));
    }
  }

  return details;
}

async function run<T extends object>(dto: ClassType<T>, input: object, implicitConversion: boolean): Promise<T> {
  const instance = plainToInstance(dto, input, {
    enableImplicitConversion: implicitConversion,
    exposeDefaultValues: true,
  });
  const errors = await validate(instance, VALIDATOR_OPTIONS);
  if (errors.length > 0) {
    throw ValidationFailed.withDetails(toDetails(errors));
  }
  return instance;
}

export async function validateBody<T extends object>(dto: ClassType<T>, body: unknown): Promise<T> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw ValidationFailed.withDetails([{ field: "body", issue: "must be a JSON object" }]);
  }

  // Class-level @MinProperties is counted on the raw body: every declared field exists as an own
  // `undefined` property on the instance, so the instance cannot answer "how many were sent".
  const minProperties = minPropertiesOf(dto);
  if (minProperties !== undefined && Object.keys(body).length < minProperties) {
    throw ValidationFailed.withDetails([
      {
        field: "body",
        issue:
          minProperties === 1
            ? "must contain at least one property"
            : `must contain at least ${String(minProperties)} properties`,
      },
    ]);
  }

  return run(dto, body, false);
}

export async function validateQuery<T extends object>(dto: ClassType<T>, query: unknown): Promise<T> {
  return run(dto, asObject(query), true);
}

export async function validateParams<T extends object>(dto: ClassType<T>, params: unknown): Promise<T> {
  return run(dto, asObject(params), true);
}

function asObject(value: unknown): object {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw ValidationFailed.withDetails([{ field: "query", issue: "must be a set of query parameters" }]);
  }
  return value;
}
