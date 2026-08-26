import type { InvocationGrantId } from "../../domain/identifiers";

export type HostedCommentTokenMintState =
  | "prepared"
  | "dispatching"
  | "issued"
  | "revoke_pending"
  | "outcome_unknown"
  | "failed_no_token"
  | "revoked"
  | "expired";

export type PreparedHostedCommentTokenMint = Readonly<{
  mintId: string;
  state: "prepared";
  fenceEpoch: bigint;
  runtimeAuthzEpoch: bigint;
  runtimeGateRevision: bigint;
  githubInstallationId: string;
  githubRepositoryId: string;
  repositoryFullName: string;
  workspaceId: string;
  poolId: string;
}>;

export type HostedCommentTokenSecretEnvelope = Readonly<{
  ciphertext: Uint8Array;
  encryptedDataKey: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  keyId: string;
  aadHash: string;
}>;

export interface HostedCommentTokenSecretVaultPort {
  seal(input: {
    readonly mintId: string;
    readonly workspaceId: string;
    readonly poolId: string;
    readonly token: string;
  }): Promise<HostedCommentTokenSecretEnvelope>;
  open(input: {
    readonly mintId: string;
    readonly workspaceId: string;
    readonly poolId: string;
    readonly envelope: HostedCommentTokenSecretEnvelope;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array>;
}

export interface HostedCommentTokenPreparedSecretVaultPort extends HostedCommentTokenSecretVaultPort {
  prepareSeal(input: {
    readonly mintId: string;
    readonly workspaceId: string;
    readonly poolId: string;
  }): Promise<
    Readonly<{
      capture(token: string): HostedCommentTokenSecretEnvelope;
      destroy(): void;
    }>
  >;
}

export type HostedCommentTokenRevocationClaim = Readonly<{
  mintId: string;
  ownerIdHash: string;
  fenceEpoch: bigint;
  tokenHash: string;
  tokenExpiresAt: Date;
  repositoryFullName: string;
  workspaceId: string;
  poolId: string;
  secretEnvelope: HostedCommentTokenSecretEnvelope;
}>;

export interface HostedCommentTokenRevocationProviderPort {
  revoke(input: {
    readonly token: string;
    readonly signal: AbortSignal;
  }): Promise<
    Readonly<{
      evidenceHash: string;
      receipt: Readonly<{
        authority: "github_token_delete";
        result: "revoked" | "already_invalid";
      }>;
    }>
  >;
}

/** Durable authority ledger. Implementations run only short, network-free transactions. */
export interface HostedCommentTokenMintLedgerPort {
  /**
   * Bounded, database-clock recovery. It terminalizes only rows whose durable
   * no-send or provider-ambiguity barriers have elapsed and never performs I/O.
   */
  recoverStale(input: { readonly limit: number }): Promise<number>;

  prepare(input: {
    readonly mintId: string;
    readonly purpose: "initial" | "refresh";
    readonly ownerIdHash: string;
    readonly logicalKeyHash: string;
    readonly requestFingerprintHash: string;
    readonly grantId: InvocationGrantId;
    readonly bindingId: string;
    readonly bindingVersion: number;
    readonly presentedTokenHash?: string;
    readonly requestIdHash?: string;
    readonly now: Date;
    readonly leaseExpiresAt: Date;
  }): Promise<
    | PreparedHostedCommentTokenMint
    | Readonly<{
        mintId: string;
        state: Exclude<HostedCommentTokenMintState, "prepared">;
      }>
  >;

  authorizeDispatch(input: {
    readonly mintId: string;
    readonly ownerIdHash: string;
    readonly now: Date;
    readonly dispatchAuthorizedUntil: Date;
    readonly unsafeUntil: Date;
  }): Promise<void>;

  releasePrepared(input: {
    readonly mintId: string;
    readonly ownerIdHash: string;
    readonly errorCode: string;
  }): Promise<void>;

  /** Final database-authoritative fence immediately before provider I/O. */
  confirmDispatch(input: {
    readonly mintId: string;
    readonly ownerIdHash: string;
  }): Promise<
    Readonly<{
      sendAuthorizedUntil: Date;
      /** Computed from the same fresh DB clock used to accept the dispatch. */
      remainingBudgetMs: number;
    }>
  >;

  /**
   * Atomically linearizes replay delivery with live authority, state and expiry.
   * Implementations must lock authority before the mint and use a fresh DB clock.
   */
  replayAuthorized(input: { readonly mintId: string }): Promise<
    Readonly<{
      tokenHash: string;
      tokenExpiresAt: Date;
      repositoryFullName: string;
      workspaceId: string;
      poolId: string;
      secretEnvelope: HostedCommentTokenSecretEnvelope;
    }>
  >;

  /** Last fence after vault decryption; authorization and delivery are atomic. */
  confirmReplayDelivery(input: {
    readonly mintId: string;
    readonly tokenHash: string;
    readonly deliveryClaimIdHash: string;
  }): Promise<void>;

  releaseDelivery(input: {
    readonly mintId: string;
    readonly tokenHash: string;
    readonly deliveryClaimIdHash: string;
  }): Promise<void>;

  finalizeKnownToken(input: {
    readonly mintId: string;
    readonly ownerIdHash: string;
    readonly fenceEpoch: bigint;
    readonly tokenHash: string;
    readonly tokenExpiresAt: Date;
    readonly secretEnvelope: HostedCommentTokenSecretEnvelope;
    readonly now: Date;
  }): Promise<"issued" | "revoke_pending">;

  stageRevocation(input: {
    readonly mintId: string;
    readonly tokenHash: string;
    readonly tokenExpiresAt: Date;
    readonly secretEnvelope?: HostedCommentTokenSecretEnvelope;
    readonly now: Date;
    readonly errorCode: string;
  }): Promise<void>;
  claimRevocations(input: {
    readonly ownerIdHash: string;
    readonly now: Date;
    readonly leaseExpiresAt: Date;
    readonly limit: number;
  }): Promise<readonly HostedCommentTokenRevocationClaim[]>;
  releaseRevocation(input: {
    readonly mintId: string;
    readonly ownerIdHash: string;
    readonly fenceEpoch: bigint;
    readonly now: Date;
    readonly errorCode: string;
  }): Promise<void>;
  finalizeOutcomeUnknown(input: {
    readonly mintId: string;
    readonly ownerIdHash: string;
    readonly now: Date;
    readonly errorCode: string;
    readonly unsafeUntil?: Date;
  }): Promise<void>;
  finalizeRevoked(input: {
    readonly mintId: string;
    readonly tokenHash: string;
    readonly now: Date;
    readonly evidenceHash: string;
    readonly ownerIdHash: string;
    readonly fenceEpoch: bigint;
    readonly receipt: Readonly<{
      readonly authority: "github_token_delete";
      readonly result: "revoked" | "already_invalid";
    }>;
  }): Promise<void>;
  observe(input: { readonly mintId: string }): Promise<Readonly<{
    state: HostedCommentTokenMintState;
    tokenHash: string | null;
  }> | null>;
}

/** Non-serializable handoff from custody to the HTTP response lifecycle. */
export const hostedCommentTokenDelivery = Symbol.for(
  "reviewrouter.hosted-comment-token-delivery",
);

export type HostedCommentTokenDeliveryCarrier = {
  readonly [hostedCommentTokenDelivery]?: () => Promise<void>;
};
