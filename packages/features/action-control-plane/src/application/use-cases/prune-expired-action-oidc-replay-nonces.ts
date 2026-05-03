import type {
  ActionOidcReplayNonceCleanupPort,
  DeleteExpiredActionOidcReplayNoncesResult,
} from "../ports/action-oidc-replay-nonce-store-port.js";

export type PruneExpiredActionOidcReplayNoncesInput = {
  readonly expiredBefore: Date;
  readonly limit: number;
};

export async function pruneExpiredActionOidcReplayNonces(
  input: PruneExpiredActionOidcReplayNoncesInput,
  dependencies: {
    readonly replayNonces: ActionOidcReplayNonceCleanupPort;
  },
): Promise<DeleteExpiredActionOidcReplayNoncesResult> {
  if (input.limit <= 0 || !Number.isFinite(input.limit)) {
    throw new Error("invalid_action_oidc_replay_nonce_prune_limit");
  }

  return dependencies.replayNonces.deleteExpiredNonces({
    expiredBefore: input.expiredBefore,
    limit: Math.floor(input.limit),
  });
}
