import type {
  CodexRotatingSetupRecoveryDecision,
  CodexRotatingSetupRecoverySnapshot,
} from "../../domain/codex-rotating-setup-recovery";

export type CodexRotatingIdentityQuarantineReadModel = {
  readonly providerInstanceRowId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly observedProviderInstanceId: string;
  readonly expectedProviderInstanceId: string | null;
  readonly reason: string;
  readonly quarantinedAt: Date;
};

export type CodexRotatingSetupRecoveryResult = {
  readonly status: "recovered" | "idempotent_replay";
  readonly recoveryEpoch: bigint;
};

export type CodexRotatingSetupRecoveryStatus =
  | { readonly status: "ready" }
  | { readonly status: "fetched_setup_recovery_required" }
  | { readonly status: "recovery_required" }
  | {
      readonly status: "identity_quarantined";
      readonly quarantine: CodexRotatingIdentityQuarantineReadModel;
    }
  | { readonly status: "issuance_quiesced" };

export interface CodexRotatingSetupRecoveryPort {
  recover(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly githubRepositoryId: string;
    readonly recoveryRequestId: string;
    readonly actor: string;
    readonly acknowledgement: string;
    readonly decide: (
      snapshot: CodexRotatingSetupRecoverySnapshot,
    ) => CodexRotatingSetupRecoveryDecision;
    readonly now: Date;
  }): Promise<CodexRotatingSetupRecoveryResult>;

  findIdentityQuarantine(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
  }): Promise<CodexRotatingIdentityQuarantineReadModel | null>;

  inspectStatus(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly issuanceEnabled: boolean;
  }): Promise<CodexRotatingSetupRecoveryStatus>;
}
