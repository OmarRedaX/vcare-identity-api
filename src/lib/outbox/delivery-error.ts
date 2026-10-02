/**
 * Thrown by a job handler (or an email adapter) to tell the processor how to finish the job.
 * `errorClass` is a short, non-sensitive label — it is the only thing written to `outbox_jobs.last_error`
 * and logged; provider response bodies are never read into either (spec §5.5).
 */
export class OutboxDeliveryError extends Error {
  readonly retryable: boolean;
  readonly errorClass: string;

  constructor(errorClass: string, retryable: boolean) {
    super(errorClass);
    this.name = "OutboxDeliveryError";
    this.errorClass = errorClass;
    this.retryable = retryable;
  }
}
