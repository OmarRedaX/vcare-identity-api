import type { RequestAuth } from "./types";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: RequestAuth;
    }
  }
}

export {};
