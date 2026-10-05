import type { z } from "zod";
import type { envSchema } from "./env.schema";

export type Env = z.infer<typeof envSchema>;

/** One configured Ed25519 signing key, exactly as declared in JWT_PRIVATE_KEYS. */
export type SigningKeyEntry = NonNullable<Env["JWT_PRIVATE_KEYS"]>[number];

export interface SigningConfig {
  keys: readonly SigningKeyEntry[];
  /** JWT_ACTIVE_KID when set, else the first configured kid. */
  activeKid: string;
}

export interface ResendEmailConfig {
  kind: "resend";
  apiKey: string;
  from: string;
  baseUrl: string;
}

export interface CaptureEmailConfig {
  kind: "capture";
  from: string;
  directory: string;
}

export type EmailConfig = ResendEmailConfig | CaptureEmailConfig;
