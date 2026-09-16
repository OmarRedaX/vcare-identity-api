import { spawn } from "node:child_process";

/**
 * Child-process checks for the entrypoints. Signal delivery is POSIX-only: on Windows `child.kill("SIGTERM")`
 * maps to TerminateProcess, which never runs Node's signal handlers, so the graceful-shutdown cases would fail
 * for a reason that has nothing to do with the code. They run on CI (ubuntu-latest) and are skipped on win32.
 */
const describeSignals = process.platform === "win32" ? describe.skip : describe;

interface RunResult {
  code: number | null;
  stdout: string;
}

function childEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  return env;
}

function run(
  entrypoint: string,
  env: NodeJS.ProcessEnv,
  options?: { signalAfterStdout?: string; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let signalled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit in time; stdout was: ${stdout}`));
    }, options?.timeoutMs ?? 15_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const marker = options?.signalAfterStdout;
      if (marker !== undefined && !signalled && stdout.includes(marker)) {
        signalled = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", () => undefined);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("environment validation", () => {
  it("should exit 1 and name the key without its value when DATABASE_URL is missing", async () => {
    const secret = "postgres://identity:fixture-db-secret@localhost:5435/vcare_identity_test";
    const result = await run(
      "src/server.ts",
      childEnv({ DATABASE_URL: undefined, DATABASE_URL_BACKUP: secret }),
    );

    expect(result.code).toBe(1);
    const line = result.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith("{"))
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .find((entry) => entry.message === "invalid_environment");

    expect(line).toBeDefined();
    expect(line?.level).toBe("error");
    expect(line?.service).toBe("identity-service");
    expect(line?.invalidKeys).toContain("DATABASE_URL");
    expect(result.stdout).not.toContain("fixture-db-secret");
  }, 30_000);
});

describeSignals("graceful shutdown", () => {
  it("should serve readiness and exit 0 when the server receives SIGTERM", async () => {
    const result = await run(
      "src/server.ts",
      childEnv({ PORT: "34971", INTERNAL_PORT: "34972", LOG_LEVEL: "info" }),
      { signalAfterStdout: '"listener":"internal"' },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("shutdown_started");
  }, 30_000);

  it("should exit 0 when the idle worker receives SIGTERM", async () => {
    const result = await run("src/worker.ts", childEnv({ LOG_LEVEL: "info" }), {
      signalAfterStdout: "worker_started",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("worker_stopping");
  }, 30_000);
});
