/** Every non-entity type of the module (CLAUDE.md -> Module file conventions, item 11). */

/** A validated token request; the service splits and de-duplicates `scope`. */
export interface IssueTokenCommand {
  clientId: string;
  clientSecret: string;
  scope: string;
  audience: string;
}

export interface IssueTokenResult {
  accessToken: string;
  /** Granted scopes, space-separated: exactly the requested ones (D-6). */
  scope: string;
}

// ── database row ──
export interface ServiceClientRow {
  id: string | number;
  client_id: string;
  name: string;
  client_secret_hash: string;
  previous_secret_hash: string | null;
  previous_secret_expires_at: Date | null;
  allowed_scopes: string[];
  allowed_audiences: string[];
  is_active: boolean;
  secret_rotated_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}
