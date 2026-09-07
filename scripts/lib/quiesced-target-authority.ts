type TargetAuthorityClient = { $disconnect(): Promise<void> };

/** The permit is already installed when the migration caller enters this boundary.
 * Prisma reconnects lazily on subsequent verification queries, after migration. */
export async function withDrainedTargetAuthorityPools<T>(
  clients: {
    permitInstallerPrisma: TargetAuthorityClient;
    targetReceiptReaderPrisma: TargetAuthorityClient;
  },
  migrate: () => T | Promise<T>,
): Promise<T> {
  const drained = await Promise.allSettled([
    clients.permitInstallerPrisma.$disconnect(),
    clients.targetReceiptReaderPrisma.$disconnect(),
  ]);
  for (const result of drained) {
    if (result.status === "rejected") throw result.reason;
  }
  return migrate();
}
