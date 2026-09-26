import type { EmailTemplate } from "../types";

/**
 * Pure email content — no clock, no env singleton, no I/O. English only in MVP.
 *
 * Both one-time secrets are **typed** by the user (ADR 0006, ADR 0017): the text carries the code and only
 * the bare `<APP_BASE_URL>` path, so no secret ever appears in a URL and there is nothing to leak through
 * proxy logs, `Referer` headers, browser history, prefetching, or a forwarded link.
 */
export function registrationCodeEmail(code: string): EmailTemplate {
  return {
    subject: "Your vcare verification code",
    text:
      `Your vcare verification code is ${code}. It expires in 10 minutes. ` +
      "If you did not try to create a vcare account, you can ignore this email.",
  };
}

export function accountExistsNoticeEmail(appBaseUrl: string): EmailTemplate {
  return {
    subject: "You already have a vcare account",
    text:
      "Someone tried to create a vcare account with this email address, but an account already exists. " +
      `Sign in at ${appBaseUrl}/login, or reset your password at ${appBaseUrl}/forgot-password. ` +
      "If this was not you, you can ignore this email.",
  };
}

export function passwordResetEmail(code: string, appBaseUrl: string): EmailTemplate {
  return {
    subject: "Reset your vcare password",
    text:
      `Your vcare password reset code is ${code}. It expires in 30 minutes. ` +
      `Enter it with your email address at ${appBaseUrl}/reset-password to set a new password. ` +
      "If you did not ask for this, you can ignore this email; your password is unchanged.",
  };
}
