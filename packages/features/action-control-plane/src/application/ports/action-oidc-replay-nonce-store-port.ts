export type ConsumeActionOidcReplayNonceInput = {
  readonly key: string;
  readonly expiresAt: Date;
  readonly now: Date;
};

export type DeleteExpiredActionOidcReplayNoncesInput = {
  readonly expiredBefore: Date;
  readonly limit: number;
};

export type DeleteExpiredActionOidcReplayNoncesResult = {
  readonly deleted: number;
};

export interface ActionOidcReplayNonceStorePort {
  tryConsumeNonce(input: ConsumeActionOidcReplayNonceInput): Promise<boolean>;
}

export interface ActionOidcReplayNonceCleanupPort {
  deleteExpiredNonces(
    input: DeleteExpiredActionOidcReplayNoncesInput,
  ): Promise<DeleteExpiredActionOidcReplayNoncesResult>;
}
