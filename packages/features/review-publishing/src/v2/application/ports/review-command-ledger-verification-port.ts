import type { ReviewPublicationScope } from "../../domain/review-publication-attempt";

export enum ReviewCommandLedgerVerificationStatus {
  Valid = "valid",
  Invalid = "invalid",
  Unavailable = "unavailable",
}

export type ReviewCommandLedgerVerificationDecision =
  | {
      readonly status: ReviewCommandLedgerVerificationStatus.Valid;
      readonly commandLedgerWatermark: bigint;
      readonly commandLedgerStateDigest: string;
    }
  | {
      readonly status:
        | ReviewCommandLedgerVerificationStatus.Invalid
        | ReviewCommandLedgerVerificationStatus.Unavailable;
    };

export type ReviewCommandLedgerRepositoryBinding = Readonly<{
  githubRepositoryId: string;
  repositoryFullName: string;
}>;

export interface ReviewCommandLedgerVerificationPort {
  verify(input: {
    readonly scope: ReviewPublicationScope;
    readonly repository: ReviewCommandLedgerRepositoryBinding;
    readonly markerBody: string;
  }): Promise<ReviewCommandLedgerVerificationDecision>;
}

export interface ReviewCommandLedgerKeyDerivationPort {
  deriveLedgerKey(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
  }): string | null;
}
