/** Populated by the guards that land with the auth module; declared here so express.d.ts can reference it. */
export interface UserAuth {
  kind: "user";
  userId: number;
  role: string;
  status: string;
  ev: boolean;
}

export interface ServiceAuth {
  kind: "service";
  clientId: string;
  scopes: readonly string[];
}

export type RequestAuth = UserAuth | ServiceAuth;
