export interface KnexOptions {
  databaseUrl: string;
  poolMax: number;
  statementTimeoutMs: number | null;
}
