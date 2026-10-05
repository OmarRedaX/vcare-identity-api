/** Result of verifying a stored hash: `needsRehash` asks the caller to write an argon2id hash (BR-10). */
export interface PasswordVerification {
  ok: boolean;
  needsRehash: boolean;
}

export interface Argon2Parameters {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}
