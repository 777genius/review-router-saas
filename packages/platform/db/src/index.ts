export type DatabaseHealth = {
  readonly connected: boolean;
  readonly checkedAt: Date;
};

export function createDatabaseHealth(
  connected: boolean,
  checkedAt = new Date(),
): DatabaseHealth {
  return { connected, checkedAt };
}
