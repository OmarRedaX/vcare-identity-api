import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { buildJwks } from "../../../lib/auth/jwks";
import type { SigningKeySet } from "../../../lib/auth/types";
import { TOKENS } from "../../../lib/di/tokens";
import { sendRaw } from "../../../lib/http/response";
import type { JwksDocument } from "../../../lib/auth/types";

/** Consumers may cache the key set for 5 minutes (contract `getJwks`). */
const CACHE_CONTROL = "public, max-age=300";

/**
 * `GET /.well-known/jwks.json` — a **bare** JWK Set (not the success envelope), so any standard JOSE
 * library can consume it. Served from memory: no Postgres, no Redis, no outbound call (budget p95 < 10 ms),
 * and the private half is never in the document (BR-26).
 */
@injectable()
export class JwksController {
  private readonly document: JwksDocument;

  constructor(@inject(TOKENS.SigningKeys) keys: SigningKeySet) {
    this.document = buildJwks(keys);
  }

  jwks = (_req: Request, res: Response): void => {
    res.setHeader("Cache-Control", CACHE_CONTROL);
    sendRaw(res, 200, this.document);
  };
}
