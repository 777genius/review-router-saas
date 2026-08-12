import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

export type ClaimedReviewProgress = Readonly<{
  scope: Readonly<{
    workspaceId: string;
    repositoryConnectionId: string;
    scmRepositoryIdentityId: string;
    pullRequestNumber: number;
  }>;
  executionId: string;
  generation: bigint;
  headSha: string;
  planHash: string;
  desiredVersion: bigint;
  publishedVersion: bigint;
  commentId: bigint | null;
  publishedBodyHash: string | null;
  snapshot: unknown;
  terminal: boolean;
  repository: Readonly<{
    owner: string;
    name: string;
    githubInstallationId: bigint;
  }>;
  claim: Readonly<{
    claimId: string;
    ownerIdHash: string;
    claimUntil: Date;
  }>;
}>;

export class PrismaReviewProgressPublicationStore {
  private readonly allowedRepositoryFullNames: ReadonlySet<string> | null;

  constructor(
    private readonly prisma: PrismaClient,
    options: {
      readonly allowedRepositoryFullNames?: ReadonlySet<string> | null;
    } = {},
  ) {
    this.allowedRepositoryFullNames =
      options.allowedRepositoryFullNames === undefined
        ? null
        : options.allowedRepositoryFullNames;
  }

  async claimNext(input: {
    readonly ownerIdHash: string;
    readonly now: Date;
    readonly claimDurationMs: number;
  }): Promise<ClaimedReviewProgress | null> {
    assertOwner(input.ownerIdHash);
    assertDuration(input.claimDurationMs);
    const repositoryPredicate = this.allowedRepositoryFullNames
      ? Prisma.sql`
          AND EXISTS (
            SELECT 1 FROM "RepositoryConnection" repository
            WHERE repository."id" = publication."repositoryConnectionId"
              AND LOWER(repository."fullName") IN (${Prisma.join([
                ...this.allowedRepositoryFullNames,
              ])})
          )`
      : Prisma.empty;
    return this.prisma.$transaction(
      async (transaction) => {
        const rows = await transaction.$queryRaw<
          Array<{
            workspaceId: string;
            repositoryConnectionId: string;
            scmRepositoryIdentityId: string;
            pullRequestNumber: number;
          }>
        >(Prisma.sql`
        SELECT publication."workspaceId", publication."repositoryConnectionId",
          publication."scmRepositoryIdentityId", publication."pullRequestNumber"
        FROM "ReviewProgressPublicationV1" publication
        WHERE publication."desiredVersion" > publication."publishedVersion"
          AND publication."nextPublishAt" <= ${input.now}
          AND (publication."claimUntil" IS NULL OR publication."claimUntil" <= ${input.now})
          ${repositoryPredicate}
        ORDER BY
          CASE WHEN EXISTS (
            SELECT 1 FROM "ReviewExecutionProgressV1" progress
            WHERE progress."executionId" = publication."activeExecutionId"
              AND progress."terminalOutcome" IS NOT NULL
          ) THEN 0 ELSE 1 END,
          publication."nextPublishAt", publication."updatedAt"
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
        const candidate = rows[0];
        if (!candidate) return null;
        const publication =
          await transaction.reviewProgressPublicationV1.findUniqueOrThrow({
            where: {
              workspaceId_repositoryConnectionId_scmRepositoryIdentityId_pullRequestNumber:
                candidate,
            },
          });
        const progress = await transaction.reviewExecutionProgressV1.findUnique(
          {
            where: { executionId: publication.activeExecutionId },
          },
        );
        if (
          !progress ||
          progress.generation !== publication.activeGeneration ||
          progress.headSha !== publication.activeHeadSha ||
          progress.planHash !== publication.activePlanHash ||
          progress.desiredVersion !== publication.desiredVersion
        ) {
          throw new Error("review_progress_projection_identity_corrupted");
        }
        const repository = await transaction.repositoryConnection.findUnique({
          where: { id: publication.repositoryConnectionId },
          include: {
            installation: {
              select: { githubInstallationId: true, status: true },
            },
          },
        });
        if (
          !repository ||
          repository.workspaceId !== publication.workspaceId ||
          repository.scmRepositoryIdentityId !==
            publication.scmRepositoryIdentityId ||
          !repository.installation ||
          repository.installation.status !== "active" ||
          repository.selected !== true ||
          repository.archived !== false ||
          repository.provider !== "github"
        ) {
          throw new Error("review_progress_github_repository_unavailable");
        }
        const claimId = randomUUID();
        const claimUntil = new Date(
          input.now.getTime() + input.claimDurationMs,
        );
        await transaction.reviewProgressPublicationV1.update({
          where: {
            workspaceId_repositoryConnectionId_scmRepositoryIdentityId_pullRequestNumber:
              candidate,
          },
          data: { claimId, claimOwnerIdHash: input.ownerIdHash, claimUntil },
        });
        return {
          scope: candidate,
          executionId: progress.executionId,
          generation: progress.generation,
          headSha: progress.headSha,
          planHash: progress.planHash,
          desiredVersion: progress.desiredVersion,
          publishedVersion: publication.publishedVersion,
          commentId: publication.commentId,
          publishedBodyHash: publication.publishedBodyHash,
          snapshot: progress.snapshotJson,
          terminal: progress.terminalOutcome !== null,
          repository: {
            owner: repository.owner,
            name: repository.name,
            githubInstallationId: repository.installation.githubInstallationId,
          },
          claim: { claimId, ownerIdHash: input.ownerIdHash, claimUntil },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async reserveInstallationMutation(input: {
    readonly publication: ClaimedReviewProgress;
    readonly now: Date;
    readonly minimumIntervalMs: number;
  }): Promise<{ allowed: true } | { allowed: false; retryAt: Date }> {
    assertDuration(input.minimumIntervalMs);
    return this.prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw(Prisma.sql`
        INSERT INTO "ReviewProgressInstallationBudgetV1"
          ("githubInstallationId", "nextMutationAt", "updatedAt")
        VALUES (${input.publication.repository.githubInstallationId}, ${input.now}, ${input.now})
        ON CONFLICT DO NOTHING
      `);
        await transaction.$queryRaw(Prisma.sql`
        SELECT 1 FROM "ReviewProgressInstallationBudgetV1"
        WHERE "githubInstallationId" = ${input.publication.repository.githubInstallationId}
        FOR UPDATE
      `);
        const budget =
          await transaction.reviewProgressInstallationBudgetV1.findUniqueOrThrow(
            {
              where: {
                githubInstallationId:
                  input.publication.repository.githubInstallationId,
              },
            },
          );
        const stillClaimed =
          await transaction.reviewProgressPublicationV1.count({
            where: {
              ...input.publication.scope,
              activeExecutionId: input.publication.executionId,
              activeGeneration: input.publication.generation,
              activeHeadSha: input.publication.headSha,
              activePlanHash: input.publication.planHash,
              desiredVersion: input.publication.desiredVersion,
              claimId: input.publication.claim.claimId,
              claimOwnerIdHash: input.publication.claim.ownerIdHash,
              claimUntil: { gt: input.now },
            },
          });
        if (stillClaimed !== 1)
          return { allowed: false as const, retryAt: input.now };
        const availableAt = maxDate(
          budget.nextMutationAt,
          budget.cooldownUntil,
        );
        if (availableAt > input.now)
          return { allowed: false as const, retryAt: availableAt };
        await transaction.reviewProgressInstallationBudgetV1.update({
          where: {
            githubInstallationId:
              input.publication.repository.githubInstallationId,
          },
          data: {
            nextMutationAt: new Date(
              input.now.getTime() + input.minimumIntervalMs,
            ),
            updatedAt: input.now,
          },
        });
        return { allowed: true as const };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async complete(input: {
    readonly publication: ClaimedReviewProgress;
    readonly commentId: bigint;
    readonly bodyHash: string;
    readonly now: Date;
  }): Promise<boolean> {
    const nextPublishAt = input.publication.terminal
      ? input.now
      : new Date(input.now.getTime() + 60_000);
    const result = await this.prisma.reviewProgressPublicationV1.updateMany({
      where: {
        ...input.publication.scope,
        activeExecutionId: input.publication.executionId,
        activeGeneration: input.publication.generation,
        activeHeadSha: input.publication.headSha,
        activePlanHash: input.publication.planHash,
        desiredVersion: input.publication.desiredVersion,
        claimId: input.publication.claim.claimId,
        claimOwnerIdHash: input.publication.claim.ownerIdHash,
      },
      data: {
        publishedVersion: input.publication.desiredVersion,
        commentId: input.commentId,
        publishedBodyHash: input.bodyHash,
        lastPublishedAt: input.now,
        nextPublishAt,
        claimId: null,
        claimOwnerIdHash: null,
        claimUntil: null,
        failureCount: 0,
        lastErrorCode: null,
        updatedAt: input.now,
      },
    });
    return result.count === 1;
  }

  async retry(input: {
    readonly publication: ClaimedReviewProgress;
    readonly safeCode: string;
    readonly retryAt: Date;
    readonly installationCooldownUntil?: Date | undefined;
    readonly now: Date;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.reviewProgressPublicationV1.updateMany({
        where: {
          ...input.publication.scope,
          activeExecutionId: input.publication.executionId,
          activeGeneration: input.publication.generation,
          activeHeadSha: input.publication.headSha,
          activePlanHash: input.publication.planHash,
          desiredVersion: input.publication.desiredVersion,
          claimId: input.publication.claim.claimId,
          claimOwnerIdHash: input.publication.claim.ownerIdHash,
        },
        data: {
          claimId: null,
          claimOwnerIdHash: null,
          claimUntil: null,
          failureCount: { increment: 1 },
          lastErrorCode: safeCode(input.safeCode),
          nextPublishAt: input.retryAt,
          updatedAt: input.now,
        },
      });
      if (input.installationCooldownUntil) {
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO "ReviewProgressInstallationBudgetV1"
            ("githubInstallationId", "nextMutationAt", "cooldownUntil", "updatedAt")
          VALUES (
            ${input.publication.repository.githubInstallationId},
            ${input.installationCooldownUntil},
            ${input.installationCooldownUntil},
            ${input.now}
          )
          ON CONFLICT ("githubInstallationId") DO UPDATE SET
            "nextMutationAt" = GREATEST(
              "ReviewProgressInstallationBudgetV1"."nextMutationAt",
              EXCLUDED."nextMutationAt"
            ),
            "cooldownUntil" = GREATEST(
              "ReviewProgressInstallationBudgetV1"."cooldownUntil",
              EXCLUDED."cooldownUntil"
            ),
            "updatedAt" = EXCLUDED."updatedAt"
        `);
      }
    });
  }

  async suppress(input: {
    readonly publication: ClaimedReviewProgress;
    readonly safeCode: string;
    readonly now: Date;
  }): Promise<boolean> {
    const result = await this.prisma.reviewProgressPublicationV1.updateMany({
      where: {
        ...input.publication.scope,
        activeExecutionId: input.publication.executionId,
        activeGeneration: input.publication.generation,
        activeHeadSha: input.publication.headSha,
        activePlanHash: input.publication.planHash,
        desiredVersion: input.publication.desiredVersion,
        claimId: input.publication.claim.claimId,
        claimOwnerIdHash: input.publication.claim.ownerIdHash,
      },
      data: {
        publishedVersion: input.publication.desiredVersion,
        claimId: null,
        claimOwnerIdHash: null,
        claimUntil: null,
        lastErrorCode: safeCode(input.safeCode),
        updatedAt: input.now,
      },
    });
    return result.count === 1;
  }

  async promoteSettledExecutions(input: {
    readonly settlements: readonly Readonly<{
      executionId: string;
      outcome: "succeeded" | "failed" | "superseded";
    }>[];
    readonly now: Date;
  }): Promise<number> {
    let promoted = 0;
    const settlements = new Map(
      input.settlements.map((settlement) => [
        settlement.executionId,
        settlement.outcome,
      ]),
    );
    for (const [executionId, publicationOutcome] of settlements) {
      const changed = await this.prisma.$transaction(
        async (transaction) => {
          const execution = await transaction.reviewExecutionV2.findUnique({
            where: { executionId },
            select: { executionId: true, state: true },
          });
          const terminalOutcome = executionStateTerminal(
            execution?.state,
            publicationOutcome,
          );
          if (!execution || !terminalOutcome) return false;
          const progress =
            await transaction.reviewExecutionProgressV1.findUnique({
              where: { executionId },
            });
          if (!progress || progress.terminalOutcome !== null) return false;
          const publication =
            await transaction.reviewProgressPublicationV1.findUnique({
              where: {
                workspaceId_repositoryConnectionId_scmRepositoryIdentityId_pullRequestNumber:
                  {
                    workspaceId: progress.workspaceId,
                    repositoryConnectionId: progress.repositoryConnectionId,
                    scmRepositoryIdentityId: progress.scmRepositoryIdentityId,
                    pullRequestNumber: progress.pullRequestNumber,
                  },
              },
            });
          if (
            !publication ||
            publication.activeExecutionId !== executionId ||
            publication.activeGeneration !== progress.generation ||
            publication.activeHeadSha !== progress.headSha ||
            publication.activePlanHash !== progress.planHash
          )
            return false;
          const desiredVersion = publication.desiredVersion + 1n;
          const snapshot = terminalSnapshot(
            progress.snapshotJson,
            terminalOutcome,
            input.now,
          );
          const snapshotHash = hashProgressSnapshot(snapshot);
          await transaction.reviewExecutionProgressV1.update({
            where: { executionId },
            data: {
              phase: "terminal",
              terminalOutcome,
              snapshotJson: snapshot,
              snapshotHash,
              desiredVersion,
              updatedAt: input.now,
            },
          });
          await transaction.reviewProgressPublicationV1.update({
            where: {
              workspaceId_repositoryConnectionId_scmRepositoryIdentityId_pullRequestNumber:
                {
                  workspaceId: progress.workspaceId,
                  repositoryConnectionId: progress.repositoryConnectionId,
                  scmRepositoryIdentityId: progress.scmRepositoryIdentityId,
                  pullRequestNumber: progress.pullRequestNumber,
                },
            },
            data: {
              version: { increment: 1n },
              desiredVersion,
              nextPublishAt: input.now,
              updatedAt: input.now,
              // Preserve a live claim. Its completion is fenced by desiredVersion,
              // while clearing it here could allow two simultaneous GitHub writes.
            },
          });
          return true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (changed) promoted += 1;
    }
    return promoted;
  }
}

type TerminalOutcome =
  | "complete"
  | "complete_with_gaps"
  | "failed"
  | "superseded";

function executionStateTerminal(
  value: string | undefined,
  publicationOutcome: "succeeded" | "failed" | "superseded",
): TerminalOutcome | null {
  if (publicationOutcome === "failed") return "failed";
  if (publicationOutcome === "superseded") return "superseded";
  if (value === "completed") return "complete";
  if (value === "partial") return "complete_with_gaps";
  if (value === "failed") return "failed";
  if (value === "superseded") return "superseded";
  return null;
}

function terminalSnapshot(
  value: Prisma.JsonValue,
  terminal: TerminalOutcome,
  now: Date,
): Prisma.InputJsonObject {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.counts)
  ) {
    throw new Error("review_progress_snapshot_invalid");
  }
  const counts = value.counts;
  if (
    terminal === "complete" &&
    (counts.requiredCompleted !== counts.requiredTotal ||
      counts.requiredExhausted !== 0 ||
      counts.requiredCancelled !== 0)
  )
    throw new Error("review_progress_complete_outcome_inconsistent");
  if (
    terminal === "complete_with_gaps" &&
    typeof counts.requiredExhausted === "number" &&
    typeof counts.requiredCancelled === "number" &&
    counts.requiredExhausted + counts.requiredCancelled < 1
  )
    throw new Error("review_progress_partial_outcome_inconsistent");
  return {
    ...value,
    phase: "terminal",
    terminal,
    updatedAt: now.toISOString(),
  } as Prisma.InputJsonObject;
}

function isRecord(value: unknown): value is Record<string, Prisma.JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashProgressSnapshot(value: Prisma.InputJsonObject): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function assertOwner(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error("review_progress_owner_invalid");
}
function assertDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("review_progress_duration_invalid");
}
function maxDate(first: Date, second: Date | null): Date {
  return second && second > first ? second : first;
}
function safeCode(value: string): string {
  return /^[a-z0-9_]{1,120}$/.test(value)
    ? value
    : "review_progress_publish_failed";
}
