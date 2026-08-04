import type {
  InvestigationShadowEvidence,
  InvestigationShadowEvidenceScope,
} from "../../domain/investigation-shadow-evidence";

export enum InvestigationShadowEvidencePersistenceStatus {
  Persisted = "persisted",
  Idempotent = "idempotent",
  Conflict = "conflict",
}

export type InvestigationShadowEvidencePersistenceResult =
  | Readonly<{
      status:
        | InvestigationShadowEvidencePersistenceStatus.Persisted
        | InvestigationShadowEvidencePersistenceStatus.Idempotent;
      evidence: InvestigationShadowEvidence;
    }>
  | Readonly<{
      status: InvestigationShadowEvidencePersistenceStatus.Conflict;
    }>;

export interface InvestigationShadowEvidenceCommandPort {
  persist(
    evidence: InvestigationShadowEvidence,
  ): Promise<InvestigationShadowEvidencePersistenceResult>;
}

export interface InvestigationShadowEvidenceQueryPort {
  findById(
    shadowEvidenceId: string,
  ): Promise<InvestigationShadowEvidence | null>;
  findByCertificateId(
    certificateId: string,
  ): Promise<InvestigationShadowEvidence | null>;
  findByInvestigationId(
    investigationId: string,
  ): Promise<InvestigationShadowEvidence | null>;
  findByScopeRevision(input: {
    readonly scope: InvestigationShadowEvidenceScope;
    readonly reviewRevisionHash: string;
    readonly limit: number;
  }): Promise<readonly InvestigationShadowEvidence[]>;
}

export interface InvestigationShadowEvidencePrunerPort {
  prune(input: {
    readonly retainUntilOrBeforeMs: number;
    readonly limit: number;
  }): Promise<number>;
}
