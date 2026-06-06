export const codexRotatingCommentTokenRefreshTtlMs = 60 * 60 * 1000;

export function isCodexRotatingCompletedLeasePostingWindowActive(input: {
  readonly completedAt: Date;
  readonly now: Date;
  readonly ttlMs?: number;
}): boolean {
  const completedAtMs = input.completedAt.getTime();
  const nowMs = input.now.getTime();
  const ttlMs = input.ttlMs ?? codexRotatingCommentTokenRefreshTtlMs;
  if (
    !Number.isFinite(completedAtMs) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0
  ) {
    return false;
  }
  return completedAtMs + ttlMs > nowMs;
}
