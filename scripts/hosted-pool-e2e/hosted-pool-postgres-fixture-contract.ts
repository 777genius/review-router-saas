export function checkedMintTemporalFixture<
  T extends Readonly<{
    dispatchAuthorizedUntil: Date;
    unsafeUntil: Date;
    tokenExpiresAt?: Date;
  }>,
>(fixture: T): T {
  if (fixture.dispatchAuthorizedUntil > fixture.unsafeUntil)
    throw new Error("postgres_e2e_mint_dispatch_after_unsafe_horizon");
  if (fixture.tokenExpiresAt && fixture.tokenExpiresAt > fixture.unsafeUntil)
    throw new Error("postgres_e2e_mint_token_after_unsafe_horizon");
  return fixture;
}

export async function runHostedPoolFixtureTeardown(
  cleanup: () => Promise<void>,
  restoreRuntimeGate: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } finally {
    await restoreRuntimeGate();
  }
}
