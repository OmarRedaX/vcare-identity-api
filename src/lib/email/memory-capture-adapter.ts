import type { CapturedEmail, EmailMessage, EmailPort } from "./types";

/**
 * The one mock integration tests are allowed (CLAUDE.md -> Testing policy: only system-external
 * dependencies). Injected through `registerDependencies({ emailPort })`.
 */
export class MemoryCaptureEmailAdapter implements EmailPort {
  private readonly sent: CapturedEmail[] = [];

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the port passes a signal this adapter cannot honour
  send(message: EmailMessage, _signal: AbortSignal): Promise<void> {
    this.sent.push({ sentAt: new Date().toISOString(), ...message });
    return Promise.resolve();
  }

  messages(): readonly CapturedEmail[] {
    return [...this.sent];
  }

  clear(): void {
    this.sent.length = 0;
  }
}
