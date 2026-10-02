/** One outbound message. Never logged: `to` is PII and `text` carries the one-time code. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** The port every adapter implements; the worker is the only caller (ADR 0007). */
export interface EmailPort {
  send(message: EmailMessage, signal: AbortSignal): Promise<void>;
}

export interface CapturedEmail extends EmailMessage {
  sentAt: string;
}
