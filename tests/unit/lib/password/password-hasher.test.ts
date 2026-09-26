import { Logger } from "../../../../src/lib/logger/logger";
import {
  ARGON2_PARAMETERS,
  PasswordHasher,
} from "../../../../src/lib/password/password-hasher";
import { HashQueueFull, Semaphore } from "../../../../src/lib/password/semaphore";

/** argon2 and bcrypt are collaborators of this unit; the real cost belongs in the integration suite. */
jest.mock("argon2", () => ({
  hash: jest.fn(),
  verify: jest.fn(),
  needsRehash: jest.fn(),
  argon2id: 2,
}));
jest.mock("bcrypt", () => ({ compare: jest.fn() }));

const argon2Mock = jest.requireMock("argon2") as {
  hash: jest.Mock;
  verify: jest.Mock;
  needsRehash: jest.Mock;
  argon2id: number;
};
const bcryptMock = jest.requireMock("bcrypt") as { compare: jest.Mock };

const ARGON2_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA";
const BCRYPT_HASH = "$2b$10$abcdefghijklmnopqrstuv";

function logSink(): { logger: Logger; lines: () => Record<string, unknown>[]; text: () => string } {
  const written: string[] = [];
  return {
    logger: new Logger({
      service: "identity-service",
      level: "debug",
      production: false,
      sink: (line) => {
        written.push(line);
      },
    }),
    lines: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => written.join(""),
  };
}

let sink: ReturnType<typeof logSink>;
let hasher: PasswordHasher;

beforeEach(() => {
  argon2Mock.hash.mockResolvedValue(ARGON2_HASH);
  argon2Mock.verify.mockResolvedValue(true);
  argon2Mock.needsRehash.mockReturnValue(false);
  bcryptMock.compare.mockResolvedValue(true);
  sink = logSink();
  hasher = new PasswordHasher(new Semaphore(2, 10), sink.logger);
});

describe("PasswordHasher.hash", () => {
  it("should hash with the ADR 0003 argon2id parameters when a password is hashed", async () => {
    await expect(hasher.hash("Synthetic-Passw0rd")).resolves.toBe(ARGON2_HASH);

    expect(argon2Mock.hash).toHaveBeenCalledWith("Synthetic-Passw0rd", {
      type: argon2Mock.argon2id,
      ...ARGON2_PARAMETERS,
    });
    expect(ARGON2_PARAMETERS).toEqual({ memoryCost: 19456, timeCost: 2, parallelism: 1 });
  });

  it("should never write the password or the hash to a log line", async () => {
    await hasher.hash("Synthetic-Passw0rd");

    expect(sink.text()).not.toContain("Synthetic-Passw0rd");
    expect(sink.text()).not.toContain(ARGON2_HASH);
  });
});

describe("PasswordHasher.verify", () => {
  it("should verify an argon2id hash and ask for no rehash when the parameters are current", async () => {
    await expect(hasher.verify(ARGON2_HASH, "pw")).resolves.toEqual({ ok: true, needsRehash: false });

    expect(argon2Mock.verify).toHaveBeenCalledWith(ARGON2_HASH, "pw");
    expect(bcryptMock.compare).not.toHaveBeenCalled();
  });

  it("should ask for a rehash when the stored argon2id parameters are weaker", async () => {
    argon2Mock.needsRehash.mockReturnValue(true);

    await expect(hasher.verify(ARGON2_HASH, "pw")).resolves.toEqual({ ok: true, needsRehash: true });
    expect(argon2Mock.needsRehash).toHaveBeenCalledWith(ARGON2_HASH, ARGON2_PARAMETERS);
  });

  it("should not ask for a rehash when an argon2id verification fails", async () => {
    argon2Mock.verify.mockResolvedValue(false);

    await expect(hasher.verify(ARGON2_HASH, "pw")).resolves.toEqual({ ok: false, needsRehash: false });
  });

  it("should verify a legacy bcrypt hash and always ask for a rehash when it matches", async () => {
    for (const prefix of ["$2a$", "$2b$", "$2y$"]) {
      const stored = `${prefix}10$abcdefghijklmnopqrstuv`;
      await expect(hasher.verify(stored, "pw")).resolves.toEqual({ ok: true, needsRehash: true });
      expect(bcryptMock.compare).toHaveBeenCalledWith("pw", stored);
    }
  });

  it("should return ok false when the bcrypt comparison fails", async () => {
    bcryptMock.compare.mockResolvedValue(false);

    await expect(hasher.verify(BCRYPT_HASH, "pw")).resolves.toEqual({ ok: false, needsRehash: false });
  });

  it("should treat a library error on a malformed hash as a failed verification", async () => {
    argon2Mock.verify.mockRejectedValue(new Error("pchstr"));

    await expect(hasher.verify(ARGON2_HASH, "pw")).resolves.toEqual({ ok: false, needsRehash: false });
  });

  it("should warn and refuse when the stored hash has an unrecognised prefix", async () => {
    await expect(hasher.verify("plaintext", "pw")).resolves.toEqual({ ok: false, needsRehash: false });

    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "password_hash_unrecognized" }),
    );
    expect(sink.text()).not.toContain("plaintext");
  });
});

describe("PasswordHasher.verifyDummy", () => {
  it("should compute the dummy hash once and verify against it when the email is unknown", async () => {
    await hasher.verifyDummy("pw");
    await hasher.verifyDummy("pw");

    expect(argon2Mock.hash).toHaveBeenCalledTimes(1);
    expect(argon2Mock.verify).toHaveBeenCalledTimes(2);
    expect(argon2Mock.verify).toHaveBeenLastCalledWith(ARGON2_HASH, "pw");
  });

  it("should ignore the dummy result when the comparison fails", async () => {
    argon2Mock.verify.mockRejectedValue(new Error("mismatch"));

    await expect(hasher.verifyDummy("pw")).resolves.toBeUndefined();
  });
});

describe("hash queue", () => {
  it("should reject with RateLimited and count a metric when the semaphore queue is full", async () => {
    const blocked = new PasswordHasher(new Semaphore(1, 0), sink.logger);
    let release!: () => void;
    argon2Mock.hash.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve(ARGON2_HASH);
          };
        }),
    );

    const inFlight = blocked.hash("first");
    await Promise.resolve();

    await expect(blocked.hash("second")).rejects.toMatchObject({
      code: "RateLimited",
      status: 429,
      retryAfterSeconds: 1,
    });
    expect(sink.lines()).toContainEqual(expect.objectContaining({ hash_rejected: 1 }));

    release();
    await inFlight;
  });

  it("should reuse the shared HashQueueFull error when the queue rejects", async () => {
    const blocked = new PasswordHasher(new Semaphore(1, 0), sink.logger);
    argon2Mock.hash.mockImplementationOnce(() => new Promise(() => undefined));

    void blocked.hash("first");
    await Promise.resolve();

    await expect(blocked.hash("second")).rejects.toBe(HashQueueFull);
  });
});
