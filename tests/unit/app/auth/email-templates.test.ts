import {
  accountExistsNoticeEmail,
  passwordResetEmail,
  registrationCodeEmail,
} from "../../../../src/app/auth/jobs/email-templates";

const APP_BASE_URL = "https://app.example.test";
const CODE = "042195";

/** Every absolute URL in the text, so a secret can be proved absent from all of them. */
function urlsIn(text: string): string[] {
  return text.match(/https?:\/\/\S+/g) ?? [];
}

describe("registrationCodeEmail", () => {
  it("should carry the six-digit code and the 10-minute validity when a challenge is sent", () => {
    const template = registrationCodeEmail(CODE);

    expect(template.subject).toBe("Your vcare verification code");
    expect(template.text).toContain(CODE);
    expect(template.text).toContain("10 minutes");
  });

  it("should put no URL and therefore no secret in a link when a challenge is sent", () => {
    expect(urlsIn(registrationCodeEmail(CODE).text)).toEqual([]);
  });
});

describe("accountExistsNoticeEmail", () => {
  it("should point at the sign-in and forgot-password paths when the email is already registered", () => {
    const template = accountExistsNoticeEmail(APP_BASE_URL);

    expect(template.subject).toBe("You already have a vcare account");
    expect(urlsIn(template.text)).toEqual([
      `${APP_BASE_URL}/login,`,
      `${APP_BASE_URL}/forgot-password.`,
    ]);
  });

  it("should never disclose a code or an account detail when the email is already registered", () => {
    const text = accountExistsNoticeEmail(APP_BASE_URL).text;

    expect(text).not.toMatch(/[0-9]{6}/);
    expect(text).not.toContain("@");
  });
});

describe("passwordResetEmail", () => {
  it("should carry the six-digit code and the 30-minute validity when a reset is sent", () => {
    const template = passwordResetEmail(CODE, APP_BASE_URL);

    expect(template.subject).toBe("Reset your vcare password");
    expect(template.text).toContain(CODE);
    expect(template.text).toContain("30 minutes");
  });

  it("should reference the bare reset path with no token, query or fragment when a reset is sent", () => {
    const urls = urlsIn(passwordResetEmail(CODE, APP_BASE_URL).text);

    expect(urls).toEqual([`${APP_BASE_URL}/reset-password`]);
    for (const url of urls) {
      expect(url).not.toContain("?");
      expect(url).not.toContain("#");
      expect(url).not.toContain(CODE);
    }
  });

  it("should use only the given code and base URL when the text is built", () => {
    const text = passwordResetEmail(CODE, APP_BASE_URL).text;
    const withoutKnown = text.replace(CODE, "").replaceAll(APP_BASE_URL, "");

    expect(withoutKnown).not.toMatch(/[0-9]{6}/);
    expect(withoutKnown).not.toContain("http");
  });
});
