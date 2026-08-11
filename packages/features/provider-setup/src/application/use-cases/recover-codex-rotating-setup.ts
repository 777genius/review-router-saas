import { decideCodexRotatingSetupRecovery } from "../../domain/codex-rotating-setup-recovery";
import type { CodexRotatingSetupRecoveryPort } from "../ports/codex-rotating-setup-recovery-port";
import { codexRotatingSetupRecoveryRequestIdSchema } from "../../domain/codex-rotating-setup-recovery-http";

export async function recoverCodexRotatingSetup(
  input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly githubRepositoryId: string;
    readonly recoveryRequestId: string;
    readonly actor: string;
    readonly acknowledgement: string;
    readonly accountSwitch?: boolean;
    readonly now?: Date;
  },
  dependencies: { readonly recovery: CodexRotatingSetupRecoveryPort },
) {
  if (
    !codexRotatingSetupRecoveryRequestIdSchema.safeParse(
      input.recoveryRequestId,
    ).success
  ) {
    throw new Error("codex_rotating_setup_recovery_request_invalid");
  }
  return dependencies.recovery.recover({
    ...input,
    accountSwitch: input.accountSwitch === true,
    decide: (snapshot) =>
      decideCodexRotatingSetupRecovery({
        acknowledgement: input.acknowledgement,
        accountSwitch: input.accountSwitch,
        snapshot,
      }),
    now: input.now ?? new Date(),
  });
}
