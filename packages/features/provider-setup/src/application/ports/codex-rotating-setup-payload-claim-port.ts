import type {
  CodexRotatingActivation,
  CodexRotatingDispatchAttempt,
  CodexRotatingSetupPayloadClaim,
  CodexRotatingSetupRecoveryFence,
  CodexRotatingSetupReplayableClaimStatus,
  CodexRotatingSetupStatus,
} from "../../domain/codex-rotating-setup-payload-claim";

export type {
  CodexRotatingDispatchAttempt,
  CodexRotatingSetupStatus,
} from "../../domain/codex-rotating-setup-payload-claim";

export type CodexRotatingSetupClaimAdmissionStatus =
  | "prepared_replay"
  | CodexRotatingSetupReplayableClaimStatus;

export interface CodexRotatingSetupPayloadClaimPort {
  claim(claim: CodexRotatingSetupPayloadClaim): Promise<{
    readonly status: CodexRotatingSetupClaimAdmissionStatus;
    readonly claimId: string;
    readonly claimVersion: number;
    readonly prepareReplayExpiresAt: string;
    readonly recoveryExpiresAt: string;
  }>;
  authorizeDispatch(input: {
    readonly claimId: string;
    readonly idempotencyKey: string;
  }): Promise<CodexRotatingDispatchAttempt>;
  recordDispatchOutcome(input: {
    readonly claimId: string;
    readonly attemptId: string;
    readonly outcome: "definite_success" | "unknown";
    readonly responseCode?: 201 | 204;
  }): Promise<{ readonly status: "confirmed_candidate" | "retired_ambiguous" }>;
  status(claimId: string): Promise<CodexRotatingSetupStatus>;
  activate(attestation: CodexRotatingActivation): Promise<{
    readonly status: "active";
  }>;
  retireProviderGeneration(
    input: CodexRotatingSetupRecoveryFence,
  ): Promise<void>;
}
