import type { z } from "zod";
import type { envSchema } from "./env.schema";

export type Env = z.infer<typeof envSchema>;
