import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Runs the real script (BR-24): the SQL carries only the argon2id hash on stdout, the plaintext secret appears
 * once on stderr, and the script never opens a database connection (no DATABASE_URL is provided).
 */
const TSX = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const SCRIPT = path.resolve(process.cwd(), "scripts/provision-service-client.ts");
const SEED = path.resolve(process.cwd(), "scripts/seed-service-client.ts");

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete cleanEnv.DATABASE_URL;
  delete cleanEnv.REDIS_URL;
  return spawnSync(process.execPath, [TSX, script, ...args], { encoding: "utf8", env: cleanEnv, timeout: 120_000 });
}

function secretOf(stderr: string): string {
  const lines = stderr.split("\n").map((line) => line.trim());
  const banner = lines.findIndex((line) => line.includes("CLIENT SECRET"));
  return lines[banner + 1] ?? "";
}

describe("scripts/provision-service-client.ts", () => {
  it("should print the INSERT with the hash to stdout and the plaintext secret only to stderr", () => {
    const result = run(SCRIPT, [
      "--client-id", "care-service", "--name", "Care service",
      "--scopes", "users:read users:status:write", "--audiences", "vcare-identity",
    ]);

    const secret = secretOf(result.stderr);
    expect(result.status).toBe(0);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).toMatch(/^INSERT INTO service_clients \(client_id, name, client_secret_hash,/);
    expect(result.stdout).toMatch(/'\$argon2id\$v=19\$m=19456,/);
    expect(result.stderr.split(secret).length - 1).toBe(1);
  });

  it("should print the rotation UPDATE with a fresh hash for --rotate and the leaked variant", () => {
    const rotate = run(SCRIPT, ["--client-id", "care-service", "--rotate", "--overlap-hours", "6"]);
    const leaked = run(SCRIPT, ["--client-id", "care-service", "--rotate", "--leaked"]);

    expect(rotate.status).toBe(0);
    expect(rotate.stdout).toMatch(/^UPDATE service_clients SET previous_secret_hash = client_secret_hash,/);
    expect(rotate.stdout).toContain("interval '6 hours'");
    expect(rotate.stdout).not.toContain(secretOf(rotate.stderr));
    expect(leaked.status).toBe(0);
    expect(leaked.stdout).toContain("previous_secret_hash = NULL");
  });

  it("should exit 1 naming the argument, and print no SQL and no secret, when the input is invalid", () => {
    const result = run(SCRIPT, ["--client-id", "Care"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--client-id");
    expect(result.stderr).not.toContain("CLIENT SECRET");
  });
});

describe("scripts/seed-service-client.ts", () => {
  it("should exit 1 and touch nothing when NODE_ENV is production", () => {
    const result = run(SEED, [], { NODE_ENV: "production", DATABASE_URL: "postgres://identity:identity@127.0.0.1:5999/none" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refuses to run when NODE_ENV=production");
    expect(result.stdout).toBe("");
  });
});
