/**
 * A registered caller of `/internal/*`. Carries both secret hashes, so it is never passed to a DTO or a logger
 * (spec section 2.2).
 */
export class ServiceClient {
  id!: number;
  clientId!: string;
  name!: string;
  clientSecretHash!: string;
  previousSecretHash!: string | null;
  previousSecretExpiresAt!: Date | null;
  allowedScopes!: string[];
  allowedAudiences!: string[];
  isActive!: boolean;
  secretRotatedAt!: Date | null;
  lastUsedAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
  deletedAt!: Date | null;

  constructor(data: Partial<ServiceClient>) {
    Object.assign(this, data);
  }
}
