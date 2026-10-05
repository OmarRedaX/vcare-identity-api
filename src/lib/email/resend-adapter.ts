import type { ResendEmailConfig } from "../config/types";
import { OutboxDeliveryError } from "../outbox/delivery-error";
import type { EmailMessage, EmailPort } from "./types";

const REQUEST_TIMEOUT_MS = 5000;

/**
 * One `POST /emails` over Node's global `fetch` (ADR 0016: no SDK, no HTTP client). The response body is
 * **never** read — not into a log, not into `outbox_jobs.last_error` — so a provider echo of the message
 * cannot leak the code or the address.
 *
 * `401`/`403` are retryable on purpose: a rotated key lets pending jobs recover once the secret is fixed,
 * while the `dead` jobs and the `OutboxDeadJobs` alert make the outage visible.
 */
export class ResendEmailAdapter implements EmailPort {
  private readonly config: ResendEmailConfig;

  constructor(config: ResendEmailConfig) {
    this.config = config;
  }

  async send(message: EmailMessage, signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new OutboxDeliveryError("EmailTimeout", true);
      }
      throw new OutboxDeliveryError("EmailNetworkError", true);
    }

    if (response.ok) {
      return;
    }
    if (response.status === 429) {
      throw new OutboxDeliveryError("EmailProviderThrottled", true);
    }
    if (response.status === 401 || response.status === 403) {
      throw new OutboxDeliveryError("EmailProviderAuth", true);
    }
    if (response.status >= 500) {
      throw new OutboxDeliveryError("EmailProviderUnavailable", true);
    }
    throw new OutboxDeliveryError("EmailRejected", false);
  }
}
