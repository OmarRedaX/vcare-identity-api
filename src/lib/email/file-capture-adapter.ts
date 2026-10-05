import fs from "node:fs";
import path from "node:path";
import type { CaptureEmailConfig } from "../config/types";
import { OutboxDeliveryError } from "../outbox/delivery-error";
import type { CapturedEmail, EmailMessage, EmailPort } from "./types";

const FILE_NAME = "outbox.jsonl";

/**
 * Development and manual QA only (`EMAIL_PROVIDER=capture`; env validation refuses it in production).
 * Appends one JSON line per message so a CURL run can read the registration or reset code with
 * `tail -n 1 .local/mail/outbox.jsonl`. The message is written to the file, never to a log.
 */
export class FileCaptureEmailAdapter implements EmailPort {
  private readonly file: string;

  constructor(config: CaptureEmailConfig) {
    this.file = path.resolve(config.directory, FILE_NAME);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the port passes a signal this adapter cannot honour
  send(message: EmailMessage, _signal: AbortSignal): Promise<void> {
    const captured: CapturedEmail = { sentAt: new Date().toISOString(), ...message };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(captured)}\n`, "utf8");
    } catch {
      throw new OutboxDeliveryError("EmailCaptureWriteFailed", true);
    }
    return Promise.resolve();
  }
}
