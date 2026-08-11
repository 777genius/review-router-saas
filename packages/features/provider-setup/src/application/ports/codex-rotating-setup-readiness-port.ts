import type { CodexRotatingSetupReadinessTarget } from "../../domain/codex-rotating-setup-readiness";

export type ConfirmedCodexRotatingSetupReadiness = Readonly<{
  claimId: string;
  attemptId: string;
  namespaceId: string;
  namespaceEpoch: bigint;
}>;

export interface CodexRotatingSetupReadinessPort {
  inspectReady(
    target: CodexRotatingSetupReadinessTarget,
  ): Promise<ConfirmedCodexRotatingSetupReadiness>;
  confirmConfigured(
    target: CodexRotatingSetupReadinessTarget,
  ): Promise<ConfirmedCodexRotatingSetupReadiness>;
}
