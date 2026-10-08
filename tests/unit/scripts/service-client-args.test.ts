import {
  ArgumentError,
  assertSeedAllowed,
  buildInsertSql,
  buildRotateSql,
  parseProvisionArgs,
  parseSeedArgs,
  pgArrayLiteral,
  sqlLiteral,
  type NewClientArgs,
  type RotateArgs,
} from "../../../scripts/service-client-args";

const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA";

function message(argv: string[]): string {
  try {
    parseProvisionArgs(argv);
  } catch (err) {
    if (err instanceof ArgumentError) {
      return err.message;
    }
    throw err;
  }
  return "";
}

const NEW_CLIENT = [
  "--client-id", "care-service",
  "--name", "Care service",
  "--scopes", "users:read users:status:write",
  "--audiences", "vcare-identity",
];

describe("parseProvisionArgs: new client", () => {
  it("should parse a complete command into a new-client request", () => {
    expect(parseProvisionArgs(NEW_CLIENT)).toEqual({
      mode: "new",
      clientId: "care-service",
      name: "Care service",
      scopes: ["users:read", "users:status:write"],
      audiences: ["vcare-identity"],
    });
  });

  it("should de-duplicate scopes and audiences", () => {
    const parsed = parseProvisionArgs([
      "--client-id", "care-service", "--name", "Care service",
      "--scopes", "users:read users:read", "--audiences", "vcare-identity vcare-identity",
    ]) as NewClientArgs;

    expect(parsed.scopes).toEqual(["users:read"]);
    expect(parsed.audiences).toEqual(["vcare-identity"]);
  });

  it("should name the offending argument and reject an invalid client id, scope vocabulary or audience", () => {
    expect(message(["--client-id", "Care", "--name", "n", "--scopes", "users:read", "--audiences", "vcare-identity"])).toContain("--client-id");
    expect(message(["--client-id", "care-service", "--name", "n", "--scopes", "users:write", "--audiences", "vcare-identity"])).toContain("--scopes");
    expect(message(["--client-id", "care-service", "--name", "n", "--scopes", "users:read", "--audiences", "care"])).toContain("--audiences");
    expect(message(["--client-id", "care-service", "--name", "   ", "--scopes", "users:read", "--audiences", "vcare-identity"])).toContain("--name");
  });

  it("should require every argument for a new client", () => {
    expect(message(["--client-id", "care-service"])).toContain("--name");
    expect(message([])).toContain("--client-id");
    expect(message(["--client-id", "care-service", "--name", "n"])).toContain("--scopes");
    expect(message(["--client-id", "care-service", "--name", "n", "--scopes", "users:read"])).toContain("--audiences");
  });

  it("should reject unknown, repeated and valueless arguments and positionals without echoing values", () => {
    expect(message([...NEW_CLIENT, "--secret", "hunter2hunter2hunter2hunter2hunter2"])).toBe("unknown argument --secret");
    expect(message([...NEW_CLIENT, "--name", "Other"])).toBe("--name was given twice");
    expect(message(["--client-id"])).toBe("--client-id needs a value");
    expect(message(["care-service"])).toBe("unexpected positional argument");
  });

  it("should not accept rotation flags without --rotate", () => {
    expect(message([...NEW_CLIENT, "--leaked"])).toContain("--rotate");
    expect(message([...NEW_CLIENT, "--overlap-hours", "5"])).toContain("--rotate");
  });
});

describe("parseProvisionArgs: rotation", () => {
  it("should default to a 24 hour overlap", () => {
    expect(parseProvisionArgs(["--client-id", "care-service", "--rotate"])).toEqual({
      mode: "rotate",
      clientId: "care-service",
      overlapHours: 24,
    });
  });

  it("should accept --overlap-hours from 1 to 168 and reject anything else", () => {
    expect((parseProvisionArgs(["--client-id", "care-service", "--rotate", "--overlap-hours", "168"]) as RotateArgs).overlapHours).toBe(168);
    expect(message(["--client-id", "care-service", "--rotate", "--overlap-hours", "169"])).toContain("--overlap-hours");
    expect(message(["--client-id", "care-service", "--rotate", "--overlap-hours", "0"])).toContain("--overlap-hours");
    expect(message(["--client-id", "care-service", "--rotate", "--overlap-hours", "1.5"])).toContain("--overlap-hours");
  });

  it("should treat --leaked as no overlap and refuse to combine it with --overlap-hours", () => {
    expect(parseProvisionArgs(["--client-id", "care-service", "--rotate", "--leaked"])).toEqual({
      mode: "rotate",
      clientId: "care-service",
      overlapHours: null,
    });
    expect(message(["--client-id", "care-service", "--rotate", "--leaked", "--overlap-hours", "2"])).toContain("--leaked");
  });

  it("should refuse to change scopes, audiences or the name during a rotation", () => {
    expect(message(["--client-id", "care-service", "--rotate", "--scopes", "users:read"])).toContain("--scopes");
  });
});

describe("SQL builders", () => {
  it("should build the INSERT with the hash and no plaintext secret, and every column the migration requires", () => {
    const sql = buildInsertSql(parseProvisionArgs(NEW_CLIENT) as NewClientArgs, HASH);

    expect(sql).toBe(
      "INSERT INTO service_clients (client_id, name, client_secret_hash, allowed_scopes, allowed_audiences, is_active, created_at, updated_at) " +
        `VALUES ('care-service', 'Care service', '${HASH}', ARRAY['users:read', 'users:status:write']::text[], ARRAY['vcare-identity']::text[], true, now(), now());`,
    );
  });

  it("should build the rotation UPDATE with an overlap window", () => {
    const sql = buildRotateSql({ mode: "rotate", clientId: "care-service", overlapHours: 12 }, HASH);

    expect(sql).toBe(
      "UPDATE service_clients SET previous_secret_hash = client_secret_hash, " +
        "previous_secret_expires_at = now() + interval '12 hours', " +
        `client_secret_hash = '${HASH}', secret_rotated_at = now(), updated_at = now() ` +
        "WHERE client_id = 'care-service' AND deleted_at IS NULL;",
    );
  });

  it("should build the leaked-secret UPDATE that clears the previous secret", () => {
    const sql = buildRotateSql({ mode: "rotate", clientId: "care-service", overlapHours: null }, HASH);

    expect(sql).toContain("previous_secret_hash = NULL, previous_secret_expires_at = NULL");
    expect(sql).not.toContain("interval");
    expect(sql).toContain(`client_secret_hash = '${HASH}'`);
  });

  it("should double single quotes when a literal contains one", () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(pgArrayLiteral(["users:read", "users:status:write"])).toBe("{users:read,users:status:write}");
  });
});

describe("seed script arguments", () => {
  it("should default to the local care-service client with users:read users:status:write for vcare-identity", () => {
    expect(parseSeedArgs([])).toEqual({
      clientId: "care-service",
      name: "Care service (local)",
      scopes: ["users:read", "users:status:write"],
      audiences: ["vcare-identity"],
    });
  });

  it("should accept overrides and validate them with the same rules", () => {
    expect(parseSeedArgs(["--client-id", "ai-service", "--scopes", "doctors:read"]).clientId).toBe("ai-service");
    expect(() => parseSeedArgs(["--scopes", "nope:nope"])).toThrow(ArgumentError);
  });

  it("should refuse to run when NODE_ENV is production and allow every other value", () => {
    expect(() => {
      assertSeedAllowed("production");
    }).toThrow("refuses to run when NODE_ENV=production");
    for (const nodeEnv of [undefined, "development", "test"]) {
      expect(() => {
        assertSeedAllowed(nodeEnv);
      }).not.toThrow();
    }
  });
});
