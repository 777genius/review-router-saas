export function resolveReviewCommandLedgerHmacSecret(
  env: Readonly<Record<string, string | undefined>>,
  fallbackSecret?: string,
): string | null {
  return (
    env.REVIEW_ROUTER_LEDGER_HMAC_KEY?.trim() ||
    env.REVIEW_ROUTER_ACTION_SESSION_SECRET?.trim() ||
    fallbackSecret?.trim() ||
    env.AUTH_SECRET?.trim() ||
    null
  );
}
