import type { ResendEmailConfig } from "../../../../src/lib/config/types";
import { ResendEmailAdapter } from "../../../../src/lib/email/resend-adapter";
import { OutboxDeliveryError } from "../../../../src/lib/outbox/delivery-error";

const CONFIG: ResendEmailConfig = {
  kind: "resend",
  apiKey: "synthetic-provider-key",
  from: "no-reply@example.test",
  baseUrl: "https://provider.example.test",
};

const MESSAGE = {
  to: "amira.patient@example.test",
  subject: "Your vcare verification code",
  text: "Your vcare verification code is 123456.",
};

const originalFetch = globalThis.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function respond(status: number, body = "{}"): Response {
  return new Response(body, { status });
}

async function expectDeliveryError(
  promise: Promise<void>,
  errorClass: string,
  retryable: boolean,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(OutboxDeliveryError);
  await promise.catch((err: unknown) => {
    expect(err).toMatchObject({ errorClass, retryable });
  });
}

describe("ResendEmailAdapter.send", () => {
  it("should post the message to the provider with the API key when it delivers", async () => {
    fetchMock.mockResolvedValue(respond(200));

    await new ResendEmailAdapter(CONFIG).send(MESSAGE, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://provider.example.test/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer synthetic-provider-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      from: "no-reply@example.test",
      to: ["amira.patient@example.test"],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
    });
  });

  it("should resolve without reading the response body when the provider accepts the message", async () => {
    const response = respond(202, '{"id":"provider-id"}');
    const bodySpy = jest.spyOn(response, "text");
    fetchMock.mockResolvedValue(response);

    await new ResendEmailAdapter(CONFIG).send(MESSAGE, new AbortController().signal);

    expect(bodySpy).not.toHaveBeenCalled();
  });

  it("should map a timeout or abort to a retryable EmailTimeout", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeout);

    await expectDeliveryError(
      new ResendEmailAdapter(CONFIG).send(MESSAGE, new AbortController().signal),
      "EmailTimeout",
      true,
    );
  });

  it("should map a network failure to a retryable EmailNetworkError", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expectDeliveryError(
      new ResendEmailAdapter(CONFIG).send(MESSAGE, new AbortController().signal),
      "EmailNetworkError",
      true,
    );
  });

  it("should map provider statuses to the documented error classes", async () => {
    const cases: [number, string, boolean][] = [
      [429, "EmailProviderThrottled", true],
      [401, "EmailProviderAuth", true],
      [403, "EmailProviderAuth", true],
      [500, "EmailProviderUnavailable", true],
      [503, "EmailProviderUnavailable", true],
      [422, "EmailRejected", false],
      [400, "EmailRejected", false],
    ];

    for (const [status, errorClass, retryable] of cases) {
      fetchMock.mockResolvedValue(respond(status));
      await expectDeliveryError(
        new ResendEmailAdapter(CONFIG).send(MESSAGE, new AbortController().signal),
        errorClass,
        retryable,
      );
    }
  });

  it("should never carry the provider response or the recipient in the error", async () => {
    fetchMock.mockResolvedValue(respond(422, '{"message":"amira.patient@example.test rejected"}'));

    await new ResendEmailAdapter(CONFIG)
      .send(MESSAGE, new AbortController().signal)
      .catch((err: unknown) => {
        const serialized = `${(err as Error).message}${(err as Error).stack ?? ""}`;
        expect(serialized).not.toContain("amira.patient@example.test");
        expect(serialized).not.toContain("synthetic-provider-key");
      });
  });

  it("should abort the request when the caller's signal is already aborted", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const error = new Error("aborted");
      error.name = "AbortError";
      return init.signal?.aborted === true ? Promise.reject(error) : Promise.resolve(respond(200));
    });
    const controller = new AbortController();
    controller.abort();

    await expectDeliveryError(
      new ResendEmailAdapter(CONFIG).send(MESSAGE, controller.signal),
      "EmailTimeout",
      true,
    );
  });
});
