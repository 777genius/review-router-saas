export type ExpireIssuedInvocationGrantsInput = Readonly<{
  now: Date;
  limit: number;
}>;

export interface InvocationGrantExpiryPort {
  /** Atomically claims and expires at most `limit` eligible issued grants. */
  expireIssuedBatch(input: ExpireIssuedInvocationGrantsInput): Promise<number>;

  /** Read-only saturation probe used after the bounded mutation budget is spent. */
  hasIssuedExpiringAtOrBefore(input: Readonly<{ now: Date }>): Promise<boolean>;
}
