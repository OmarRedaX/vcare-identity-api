import { logger as defaultLogger } from "../../src/lib/logger/logger";
import type { CaptureLogsOptions, LogCapture } from "./types";

/** Captures stdout so tests can assert that no secret or PII value was ever written. */
export function captureLogs(options?: CaptureLogsOptions): LogCapture {
  const target = options?.logger ?? defaultLogger;
  const captured: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  process.stdout.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === "string") {
      captured.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      captured.push(Buffer.from(chunk).toString("utf8"));
    }
    void rest;
    return true;
  };

  target.setLevel(options?.level ?? "debug");

  return {
    lines(): Record<string, unknown>[] {
      return captured
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
    },
    text(): string {
      return captured.join("");
    },
    restore(): void {
      process.stdout.write = originalWrite;
    },
  };
}
