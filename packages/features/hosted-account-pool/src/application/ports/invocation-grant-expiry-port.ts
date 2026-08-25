export type ExpireIssuedInvocationGrantsInput = Readonly<{
  now: Date;
  limit: number;
}>;

export interface InvocationGrantExpiryPort {
  /** Atomically claims and expires at most `limit` eligible issued grants. */
  expireIssuedBatch(input: ExpireIssuedInvocationGrantsInput): Promise<number>;
}
