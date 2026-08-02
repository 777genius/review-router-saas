import type { EncryptedInvestigationPrivateMaterial } from "../../domain/investigation-private-material";

export interface InvestigationPrivateMaterialCipherPort {
  encrypt(input: {
    readonly privateMaterialId: string;
    readonly investigationId: string;
    readonly obligationId: string | null;
    readonly plaintextCanonicalJson: string;
    readonly associatedDataCanonicalJson: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): Promise<EncryptedInvestigationPrivateMaterial>;
  decrypt(input: {
    readonly material: EncryptedInvestigationPrivateMaterial;
    readonly associatedDataCanonicalJson: string;
  }): Promise<string>;
}

export enum InvestigationPrivateMaterialPersistenceStatus {
  Created = "created",
  Idempotent = "idempotent",
  Conflict = "conflict",
}

export interface InvestigationPrivateMaterialStorePort {
  savePrivateMaterial(
    material: EncryptedInvestigationPrivateMaterial,
  ): Promise<InvestigationPrivateMaterialPersistenceStatus>;
  findActivePrivateMaterial(input: {
    readonly investigationId: string;
    readonly obligationId: string | null;
    readonly activeAfter: string;
  }): Promise<EncryptedInvestigationPrivateMaterial | null>;
}

export interface InvestigationPrunerPort {
  pruneExpiredPrivateMaterial(input: {
    readonly expiresAtOrBefore: string;
    readonly limit: number;
  }): Promise<number>;
  pruneRetainedInvestigations(input: {
    readonly retainUntilOrBefore: string;
    readonly limit: number;
  }): Promise<number>;
}
