import fs from "node:fs";
import path from "node:path";
import { RegistrableRole, RevokedReason, UserRole, UserStatus } from "../../../../src/app/auth/enums";
import { ACCOUNT_STATUSES, ROLES } from "../../../../src/lib/rbac/types";

function migrationSource(file: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), "src", "migrations", file), "utf8");
}

/** `col IN ('a','b')` from the raw migration SQL. */
function checkValues(sql: string, constraint: string): string[] {
  const pattern = new RegExp(`${constraint}\\s+CHECK\\s*\\([^)]*IN\\s*\\(([^)]*)\\)`, "i");
  const match = pattern.exec(sql);
  if (!match?.[1]) {
    throw new Error(`constraint ${constraint} not found in the migration`);
  }
  return match[1].split(",").map((value) => value.trim().replace(/'/g, ""));
}

describe("auth enums", () => {
  it("should hold the same role and status values as the RBAC literal types", () => {
    expect(Object.values(UserRole).sort()).toEqual([...ROLES].sort());
    expect(Object.values(UserStatus).sort()).toEqual([...ACCOUNT_STATUSES].sort());
  });

  it("should match the users CHECK constraints when the migration is read", () => {
    const sql = migrationSource("20260917000100_create_users.ts");

    expect(checkValues(sql, "chk_users_role").sort()).toEqual(Object.values(UserRole).sort());
    expect(checkValues(sql, "chk_users_status").sort()).toEqual(Object.values(UserStatus).sort());
  });

  it("should match the refresh-token revoked reason CHECK constraint when the migration is read", () => {
    const sql = migrationSource("20260917000200_create_refresh_tokens.ts");

    expect(checkValues(sql, "chk_refresh_tokens_revoked_reason").sort()).toEqual(
      Object.values(RevokedReason).sort(),
    );
  });

  it("should never allow admin as a registrable role", () => {
    expect(Object.values(RegistrableRole)).toEqual(["patient", "doctor"]);
    expect(Object.values(RegistrableRole)).not.toContain(UserRole.Admin);
  });
});
