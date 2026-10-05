import { registerDecorator, type ValidationOptions } from "class-validator";
import { PASSWORD_DENYLIST } from "./denylist";

/**
 * Rejects the breached passwords in `denylist.ts` (CLAUDE.md -> Security rules). Length is checked by
 * `@Length(10, 128)` on the same property; the submitted value is never logged or echoed.
 */
export function IsAcceptablePassword(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: "isAcceptablePassword",
      target: object.constructor,
      propertyName: String(propertyName),
      options,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === "string" && !PASSWORD_DENYLIST.has(value.toLowerCase());
        },
        defaultMessage(): string {
          return "is too common";
        },
      },
    });
  };
}
