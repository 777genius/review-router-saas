import type { HostedAccountSafeSummary } from "../hosted-account-pool-dtos";
import type { ImportEnrollHostedAccountCommand } from "../hosted-account-pool-dtos";
import type { HostedCredentialEnrollmentPort } from "../ports/hosted-credential-custody-port";

export async function importAndEnrollHostedCodexAccount(
  command: ImportEnrollHostedAccountCommand,
  dependencies: {
    readonly credentialEnrollment: HostedCredentialEnrollmentPort;
  },
): Promise<HostedAccountSafeSummary> {
  return dependencies.credentialEnrollment.importCodexAuth({
    workspaceId: command.workspaceId,
    poolId: command.poolId,
    accountId: command.accountId,
    label: command.label,
    priority: command.priority,
    expectedPoolRevision: command.expectedPoolRevision,
    authJsonBytes: command.authJsonBytes,
    now: command.requestedAt,
  });
}
