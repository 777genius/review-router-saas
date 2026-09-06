import type { ImportEnrollHostedAccountCommand } from "../hosted-account-pool-dtos";
import type { HostedAccountRepositoryPort } from "../ports/hosted-account-repository-port";
import type { HostedCredentialEnrollmentPort } from "../ports/hosted-credential-custody-port";
import { importAndEnrollHostedCodexAccount } from "./import-enroll-hosted-account";
import { hostedOperatorAuthByteLimit } from "./reconnect-hosted-account";

/** Caller reads pool revision before invoking; enrollment CAS fences label checks too. */
export async function operatorImportHostedAccount(
  command: ImportEnrollHostedAccountCommand,
  dependencies: {
    readonly accounts: HostedAccountRepositoryPort;
    readonly credentialEnrollment: HostedCredentialEnrollmentPort;
    fingerprint(bytes: Uint8Array): string;
  },
) {
  try {
    if (
      command.authJsonBytes.byteLength < 1 ||
      command.authJsonBytes.byteLength > hostedOperatorAuthByteLimit
    )
      throw new Error("hosted_pool_auth_size_invalid");
    const fingerprint = dependencies.fingerprint(command.authJsonBytes);
    const reconcile = async () => {
      const accounts = await dependencies.accounts.listByPoolId(command.poolId);
      if (
        accounts.some(
          (a) =>
            a.label === command.label &&
            a.credential.subjectFingerprint !== fingerprint,
        )
      ) {
        throw new Error("hosted_pool_account_label_conflict");
      }
      const existing = accounts.find(
        (a) => a.credential.subjectFingerprint === fingerprint,
      );
      return existing
        ? {
            status: "already_imported" as const,
            accountId: existing.id,
            generation: existing.credential.authGeneration,
          }
        : null;
    };
    const existing = await reconcile();
    if (existing) return existing;
    try {
      const imported = await importAndEnrollHostedCodexAccount(
        command,
        dependencies,
      );
      return {
        status: "imported" as const,
        accountId: imported.id,
        generation: imported.authGeneration,
      };
    } catch {
      const committed = await reconcile();
      if (committed) return committed;
      throw new Error("hosted_pool_import_reconcile_required");
    }
  } finally {
    command.authJsonBytes.fill(0);
  }
}
