import { registerDecorator, ValidateIf, type ValidationOptions } from "class-validator";

/**
 * Shared custom validators and transforms for request DTOs (spec §3.5). Every message is the `issue`
 * string the error envelope renders, so it never echoes the submitted value.
 */
const MIN_PROPERTIES = Symbol.for("vcare.validation.minProperties");

/**
 * Class-level "at least n properties" rule. Because `useDefineForClassFields` gives every declared field an
 * own `undefined` property on the instance, the count can only be taken from the **raw body** — so the rule is
 * recorded on the class here and enforced by `validateBody` before transformation.
 */
export function MinProperties(min: number): ClassDecorator {
  return (target) => {
    Object.defineProperty(target, MIN_PROPERTIES, {
      value: min,
      enumerable: false,
      configurable: true,
    });
  };
}

export function minPropertiesOf(target: unknown): number | undefined {
  if (typeof target !== "function") {
    return undefined;
  }
  const value = (target as unknown as Record<symbol, unknown>)[MIN_PROPERTIES];
  return typeof value === "number" ? value : undefined;
}

const isProvided = (_object: unknown, value: unknown): boolean => value !== undefined;
const isProvidedAndNotNull = (_object: unknown, value: unknown): boolean =>
  value !== undefined && value !== null;

/** Absent → skip every other validator; `null` → still validated (and therefore rejected by `@IsString`). */
export function WhenProvided(options?: ValidationOptions): PropertyDecorator {
  return ValidateIf(isProvided, options);
}

/** Absent or `null` → skip every other validator (`null` clears the column). */
export function WhenProvidedAndNotNull(options?: ValidationOptions): PropertyDecorator {
  return ValidateIf(isProvidedAndNotNull, options);
}

/** `Intl` accepts the zone and echoes a canonical name (`africa/cairo` → `Africa/Cairo`). */
export function resolveTimeZone(value: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function resolveLocale(value: string): string | undefined {
  try {
    const canonical = Intl.getCanonicalLocales(value);
    return canonical.length === 1 ? canonical[0] : undefined;
  } catch {
    return undefined;
  }
}

/** `@Transform` helper: stores the canonical zone, leaves an invalid value for the validator to reject. */
export function canonicalTimeZone(value: unknown): unknown {
  return typeof value === "string" ? (resolveTimeZone(value) ?? value) : value;
}

export function canonicalLocale(value: unknown): unknown {
  return typeof value === "string" ? (resolveLocale(value) ?? value) : value;
}

export function trimmed(value: unknown): unknown {
  return typeof value === "string" ? value.trim() : value;
}

export function IsIanaTimeZone(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: "isIanaTimeZone",
      target: object.constructor,
      propertyName: String(propertyName),
      options,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === "string" && resolveTimeZone(value) !== undefined;
        },
        defaultMessage(): string {
          return "must be a valid IANA time zone";
        },
      },
    });
  };
}

export function IsBcp47Locale(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: "isBcp47Locale",
      target: object.constructor,
      propertyName: String(propertyName),
      options,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === "string" && resolveLocale(value) !== undefined;
        },
        defaultMessage(): string {
          return "must be a valid BCP-47 language tag";
        },
      },
    });
  };
}

/** Guards `chk_users_full_name_not_blank`, which would otherwise surface as a 500. */
export function IsNotBlank(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: "isNotBlank",
      target: object.constructor,
      propertyName: String(propertyName),
      options,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === "string" && value.trim().length > 0;
        },
        defaultMessage(): string {
          return "must not be blank";
        },
      },
    });
  };
}
