import type {
  HostedAccountId,
  HostedPoolId,
  WorkspaceId,
} from "../../domain/identifiers";
import type { HostedAccountRepositoryPort } from "../ports/hosted-account-repository-port";

export const hostedOperatorAuthByteLimit = 1024 * 1024;

/** No provider calls: validate locally, then hold only the existing short write fence. */
export async function reconnectHostedAccount(
  input: {
    readonly workspaceId: WorkspaceId;
    readonly poolId: HostedPoolId;
    readonly accountId: HostedAccountId;
    readonly expectedGeneration: number;
    readonly expectedHealthVersion: number;
    readonly authJsonBytes: Uint8Array;
  },
  dependencies: {
    readonly accounts: HostedAccountRepositoryPort;
    validate(bytes: Uint8Array): {
      readonly fingerprint: string;
      readonly generationHash: string;
    };
    acquire(accountId: string): Promise<string>;
    release(leaseId: string): Promise<void>;
    commit(command: {
      readonly workspaceId: string;
      readonly poolId: string;
      readonly accountId: string;
      readonly expectedGeneration: number;
      readonly expectedHealthVersion: number;
      readonly nextAuthJsonBytes: Uint8Array;
      readonly nextGenerationHash: string;
      readonly leaseId: string;
      readonly idempotencyKey: string;
    }): Promise<{ readonly status: string; readonly generation?: number }>;
  },
) {
  try {
    if (
      input.authJsonBytes.byteLength < 1 ||
      input.authJsonBytes.byteLength > hostedOperatorAuthByteLimit
    ) {
      throw new Error("hosted_pool_auth_size_invalid");
    }
    const account = await dependencies.accounts.findById(input.accountId);
    if (
      !account ||
      account.poolId !== input.poolId ||
      account.availability.status !== "paused" ||
      account.healthVersion !== input.expectedHealthVersion ||
      account.credential.authGeneration !== input.expectedGeneration
    ) {
      throw new Error("hosted_codex_reconnect_conflict");
    }
    const validated = dependencies.validate(input.authJsonBytes);
    if (validated.fingerprint !== account.credential.subjectFingerprint) {
      throw new Error("hosted_codex_account_identity_drift");
    }
    const leaseId = await dependencies.acquire(input.accountId);
    try {
      const result = await dependencies.commit({
        workspaceId: input.workspaceId,
        poolId: input.poolId,
        accountId: input.accountId,
        expectedGeneration: input.expectedGeneration,
        expectedHealthVersion: input.expectedHealthVersion,
        nextAuthJsonBytes: input.authJsonBytes,
        nextGenerationHash: validated.generationHash,
        leaseId,
        idempotencyKey: `operator-reconnect:${input.expectedGeneration}:${input.expectedHealthVersion}`,
      });
      if (
        result.status !== "accepted" &&
        result.status !== "idempotent_replay"
      ) {
        throw new Error("hosted_codex_reconnect_conflict");
      }
      return {
        status: "replaced" as const,
        accountId: input.accountId,
        generation: result.generation,
      };
    } finally {
      await dependencies.release(leaseId);
    }
  } finally {
    input.authJsonBytes.fill(0);
  }
}
