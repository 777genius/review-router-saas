import { decideCodexRotatingSetupRecovery } from "../../domain/codex-rotating-setup-recovery";
import type { CodexRotatingSetupRecoveryPort } from "../ports/codex-rotating-setup-recovery-port";

export async function recoverCodexRotatingSetup(
  input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly githubRepositoryId: string;
    readonly recoveryRequestId: string;
    readonly actor: string;
    readonly acknowledgement: string;
    readonly now?: Date;
  },
  dependencies: { readonly recovery: CodexRotatingSetupRecoveryPort },
) {
  if (!/^[A-Za-z0-9_.:-]{8,160}$/.test(input.recoveryRequestId)) {
    throw new Error("codex_rotating_setup_recovery_request_invalid");
  }
  return dependencies.recovery.recover({
    ...input,
    decide: (snapshot) =>
      decideCodexRotatingSetupRecovery({
        acknowledgement: input.acknowledgement,
        snapshot,
      }),
    now: input.now ?? new Date(),
  });
}
