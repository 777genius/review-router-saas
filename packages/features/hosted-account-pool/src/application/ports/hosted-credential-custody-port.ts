import type { HostedAccountSafeSummary } from "../hosted-account-pool-dtos";
import type {
  HostedAccountId,
  HostedPoolId,
  WorkspaceId,
} from "../../domain/identifiers";

/**
 * AR/infrastructure-owned credential boundary. Implementations validate,
 * encrypt/import, fingerprint, and return metadata without exposing plaintext.
 */
export interface HostedCredentialEnrollmentPort {
  importCodexAuth(input: {
    readonly workspaceId: WorkspaceId;
    readonly poolId: HostedPoolId;
    readonly accountId: HostedAccountId;
    readonly label: string;
    readonly priority: number;
    readonly expectedPoolRevision: number;
    readonly authJsonBytes: Uint8Array;
    readonly now: Date;
  }): Promise<HostedAccountSafeSummary>;
}
