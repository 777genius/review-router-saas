import type { Prisma, PrismaClient } from "@prisma/client";
import {
  canonicalJson,
  parseReviewRunGatewayExecutionBinding,
  parseReviewRunRuntimeSnapshot,
  reviewRunGatewayOwnedIdentity,
  type ReviewRunGatewayExecutionAttachment,
  type ReviewRunGatewayExecutionBinding,
  type ReviewRunGatewayExecutionBindingPort,
  type ReviewRunGatewayExecutionOwner,
  type ReviewRunGatewayExecutionRead,
} from "@reviewrouter/features-review-run-control";
import type { ProductionReviewRunRuntimeSnapshot } from "./review-run-runtime-snapshot";

/** Private SQL121 attachment on the existing authority row. No public mapper,
 * capability persistence, second ledger or automatic transaction/HTTP retry. */
export class PrismaReviewRunGatewayExecutionBinding implements ReviewRunGatewayExecutionBindingPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly snapshots: ProductionReviewRunRuntimeSnapshot,
  ) {}

  async read(
    raw: ReviewRunGatewayExecutionOwner,
  ): Promise<ReviewRunGatewayExecutionRead> {
    const owner = copyOwner(raw);
    return this.prisma.$transaction(
      async (tx): Promise<ReviewRunGatewayExecutionRead> => {
        const current = await this.lockLive(tx, owner);
        if (!current) return { status: "denied" };
        return { status: "live", binding: current.binding };
      },
    );
  }

  async attach(
    raw: ReviewRunGatewayExecutionOwner,
    selected: ReviewRunGatewayExecutionBinding,
  ): Promise<ReviewRunGatewayExecutionAttachment> {
    const owner = copyOwner(raw);
    const canonical = canonicalJson(selected);
    const binding = parseReviewRunGatewayExecutionBinding(canonical);
    const snapshot = parseReviewRunRuntimeSnapshot(
      owner.runtimeSnapshotCanonicalJson,
    );
    const original = snapshot?.gateway;
    if (
      !original?.limits ||
      binding.operationId !== original.operationId ||
      binding.accountRef !== original.permittedAccountRef ||
      binding.deadline !== snapshot?.deadline
    )
      return { status: "denied" };
    return this.prisma.$transaction(
      async (tx): Promise<ReviewRunGatewayExecutionAttachment> => {
        const current = await this.lockLive(tx, owner);
        if (!current) return { status: "denied" };
        if (current.binding) {
          return canonicalJson(current.binding) === canonical
            ? { status: "restored", binding: current.binding }
            : { status: "conflict" };
        }
        // The lock and predicates preserve identity/state/snapshot. SQL121 adds
        // independent write-once, original-intent and current-deadline guards.
        const attached = await tx.$queryRaw<
          readonly { gatewayExecutionCanonicalJson: string }[]
        >`
        UPDATE "ReviewRunAuthorization"
        SET "gatewayExecutionCanonicalJson" = ${canonical}
        WHERE "authorizationId" = ${owner.authorizationId}
          AND "runtimeSnapshotCanonicalJson" = ${owner.runtimeSnapshotCanonicalJson}
          AND "gatewayExecutionCanonicalJson" IS NULL
          AND "state" = 'active'
          AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
          AND "maxExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
        RETURNING "gatewayExecutionCanonicalJson"`;
        if (attached.length !== 1 || !attached[0]) return { status: "denied" };
        const saved = parseReviewRunGatewayExecutionBinding(
          attached[0].gatewayExecutionCanonicalJson,
        );
        if (canonicalJson(saved) !== canonical)
          throw new Error("review_run_gateway_attachment_corrupt");
        return { status: "attached", binding: saved };
      },
    );
  }

  private async lockLive(
    tx: Prisma.TransactionClient,
    owner: ReviewRunGatewayExecutionOwner,
  ) {
    const snapshot = parseReviewRunRuntimeSnapshot(
      owner.runtimeSnapshotCanonicalJson,
    );
    const original = snapshot?.gateway;
    if (!snapshot || !original?.limits) return null;
    // Same connection-before-binding order as C1. Revocation/synchronization
    // cannot commit between this live read and attachment on the locked row.
    await tx.$queryRaw`
      SELECT "id" FROM "ProviderAccountConnection"
      WHERE "id" = ${original.connectionId} FOR UPDATE`;
    await tx.$queryRaw`
      SELECT "id" FROM "WorkspaceAccountBinding"
      WHERE "id" = ${original.bindingId} AND "workspaceId" = ${owner.identity.workspaceId} FOR UPDATE`;
    const privateRows = await tx.$queryRaw<
      readonly { gatewayExecutionCanonicalJson: string | null }[]
    >`
      SELECT "gatewayExecutionCanonicalJson" FROM "ReviewRunAuthorization"
      WHERE "authorizationId" = ${owner.authorizationId} FOR UPDATE`;
    if (privateRows.length !== 1 || !privateRows[0]) return null;
    const row = await tx.reviewRunAuthorization.findUnique({
      where: { authorizationId: owner.authorizationId },
    });
    if (
      !row ||
      row.state !== "active" ||
      row.runtimeSnapshotCanonicalJson !== owner.runtimeSnapshotCanonicalJson ||
      row.maxExpiresAt.toISOString() !== snapshot.deadline ||
      !Object.entries(owner.identity).every(
        ([key, value]) => Reflect.get(row, key) === value,
      )
    )
      return null;
    if (
      !(await this.snapshots.isLive(
        { snapshot, identity: owner.identity, now: new Date() },
        tx,
      ))
    )
      return null;
    const rawBinding = privateRows[0].gatewayExecutionCanonicalJson;
    const binding =
      rawBinding === null
        ? null
        : parseReviewRunGatewayExecutionBinding(rawBinding);
    if (
      binding &&
      (binding.operationId !== original.operationId ||
        binding.accountRef !== original.permittedAccountRef ||
        binding.deadline !== snapshot.deadline)
    )
      return null;
    // Use fresh DB wall time after every awaited read, rather than transaction-start time.
    const times = await tx.$queryRaw<
      readonly { now: Date }[]
    >`SELECT clock_timestamp() AS "now"`;
    const now = times[0]?.now;
    if (!now || now >= row.expiresAt || now >= row.maxExpiresAt) return null;
    return { binding };
  }
}

function copyOwner(
  owner: ReviewRunGatewayExecutionOwner,
): ReviewRunGatewayExecutionOwner {
  return {
    authorizationId: owner.authorizationId,
    runtimeSnapshotCanonicalJson: owner.runtimeSnapshotCanonicalJson,
    identity: reviewRunGatewayOwnedIdentity(owner.identity),
  };
}
