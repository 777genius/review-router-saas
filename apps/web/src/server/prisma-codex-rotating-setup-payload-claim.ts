import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  assertCodexRotatingAccountIdentityTransition,
  assertProviderSecretTransitionAuthorized,
  fingerprintDatabaseRecoveryWitness,
  codexRotatingSetupIdentityBearingClaimStatuses,
  codexRotatingSetupManifestSchema,
  codexRotatingSetupPayloadClaimsMatch,
  isCodexRotatingSetupLiveClaimStatus,
  isCodexRotatingSetupTerminalClaimStatus,
  reserveCodexRotatingSetupDispatchAuthorityWindow,
  allocateVersionedProviderSecretNamespace,
  type CodexRotatingActivation,
  type CodexRotatingDispatchAttempt,
  type CodexRotatingSetupClaimAdmissionStatus,
  type CodexRotatingSetupPayloadClaim,
  type CodexRotatingSetupRecoveryFence,
  type CodexRotatingSetupAttemptStatus,
  type CodexRotatingSetupClaimStatus,
  type CodexRotatingSetupPayloadClaimPort,
  type CodexRotatingCurrentWorkflowAttestationPort,
  type CodexRotatingWorkflowReattestationPersistencePort,
  type CodexRotatingWorkflowReattestationTransition,
  type CodexRotatingSetupStatus,
} from "@reviewrouter/features-provider-setup";
import {
  createVersionedSecretWorkflowSourceAttestation,
  WorkflowSourceTrust,
  type VersionedProviderSecretNamespace,
} from "@reviewrouter/features-workflow-provisioning";
import {
  PostgresTransactionClock,
  type TransactionClock,
} from "@reviewrouter/platform-db";
import { isCodexRotatingOAuthAllowedForRepository } from "@reviewrouter/platform-config";
import {
  isCodexRotatingSetupFenceOwner,
  lockCodexRotatingProviderRow,
  lockCodexRotatingSetupProvider,
} from "./codex-rotating-provider-mutation-fence";
import { retirePriorNamespaceGeneration } from "./prisma-codex-rotating-setup-recovery";

const transactionTimeoutMs = 10_000;
const maximumAttempts = 3;
const expiredDispatchRetired = Symbol("expired_dispatch_retired");

export type CodexRotatingWorkflowReattestationErrorCode =
  | "codex_rotating_workflow_reattestation_stale"
  | "codex_rotating_workflow_reattestation_invalid"
  | "codex_rotating_workflow_reattestation_forbidden";

export class CodexRotatingWorkflowReattestationError extends Error {
  override readonly name = "CodexRotatingWorkflowReattestationError";

  constructor(readonly code: CodexRotatingWorkflowReattestationErrorCode) {
    super(code);
  }
}

export function translateWorkflowReattestationDatabaseError(
  error: unknown,
): unknown {
  if (error instanceof CodexRotatingWorkflowReattestationError) return error;
  if (typeof error !== "object" || error === null) return error;
  const candidate = error as {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly meta?: { readonly code?: unknown; readonly message?: unknown };
  };
  if (candidate.code !== "P2010") return error;
  const sqlState =
    typeof candidate.meta?.code === "string" ? candidate.meta.code : "";
  const wrappedMessage = [candidate.message, candidate.meta?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const mappings = [
    [
      "40001",
      "codex_oauth_active_namespace_reattestation_stale",
      "codex_rotating_workflow_reattestation_stale",
    ],
    [
      "22023",
      "codex_oauth_active_namespace_reattestation_invalid",
      "codex_rotating_workflow_reattestation_invalid",
    ],
    [
      "42501",
      "codex_oauth_active_namespace_reattestation_role_forbidden",
      "codex_rotating_workflow_reattestation_forbidden",
    ],
  ] as const;
  const mapping = mappings.find(
    ([expectedState, databaseCode]) =>
      sqlState === expectedState &&
      new RegExp(
        `(?:^|[^A-Za-z0-9_])${databaseCode}(?:$|[^A-Za-z0-9_])`,
        "u",
      ).test(wrappedMessage),
  );
  return mapping
    ? new CodexRotatingWorkflowReattestationError(mapping[2])
    : error;
}

async function signDatabaseAuthorityChallenge(input: {
  readonly tx: Prisma.TransactionClient;
  readonly authority: Pick<PrismaClient, "$queryRaw">;
  readonly effect: string;
  readonly ownerId: string;
  readonly effectCode: number;
}): Promise<string> {
  const challengeRows = await input.tx.$queryRaw<
    readonly { challenge: string }[]
  >`
    SELECT "codex_oauth_database_authority_challenge"(
      ${input.effect}, ${input.ownerId}, ${input.effectCode}
    ) AS challenge
  `;
  const challenge = challengeRows[0]?.challenge;
  if (!challenge) throw new Error("codex_oauth_database_authority_unavailable");
  const signatureRows = await input.authority.$queryRaw<
    readonly { signature: string }[]
  >`
    SELECT "codex_oauth_sign_database_authority"(${challenge}) AS signature
  `;
  const signature = signatureRows[0]?.signature;
  if (!signature || !/^[a-f0-9]{64}$/u.test(signature)) {
    throw new Error("codex_oauth_database_authority_unavailable");
  }
  return signature;
}

type ManifestRow = {
  id: string;
  workspaceId: string;
  repositoryId: string;
  providerInstanceRowId: string;
  providerInstanceId: string;
  setupNonce: string;
  manifestJson: unknown;
  status: string;
  mutationEpoch: bigint | null;
  databaseRecoveryWitness: string | null;
  recoveryExpiresAt: Date | null;
};

type ClaimRow = {
  id: string;
  providerInstanceRowId: string;
  githubRepositoryId: string;
  manifestId: string;
  manifestDigest: string;
  recoveryRequestId: string | null;
  recoveryEpoch: bigint;
  operationId: string;
  payloadVersion: number;
  canonicalizationVersion: number;
  generationHash: string;
  accountIdentityHash: string;
  accountIdentityAlgorithm: string;
  authByteSize: number;
  installerVersion: string;
  installerDigest: string;
  databaseIncarnation: string;
  databaseRecoveryWitness: string;
  status: CodexRotatingSetupClaimStatus;
  claimVersion: number;
  prepareReplayExpiresAt: Date;
  recoveryExpiresAt: Date;
  confirmedAttemptId: string | null;
};

type AttemptRow = {
  claimId: string;
  attemptId: string;
  namespaceId: string;
  namespaceEpoch: bigint;
  secretName: string;
  status: CodexRotatingSetupAttemptStatus;
  dispatchExpiresAt: Date;
};

export class PrismaCodexRotatingSetupPayloadClaim
  implements
    CodexRotatingSetupPayloadClaimPort,
    CodexRotatingCurrentWorkflowAttestationPort,
    CodexRotatingWorkflowReattestationPersistencePort
{
  constructor(
    private readonly prisma: PrismaClient,
    private readonly databaseRecoveryWitness?: string,
    private readonly clock: TransactionClock = new PostgresTransactionClock(),
    private readonly runtimeEnvironment: NodeJS.ProcessEnv = process.env,
    private readonly databaseEffectAuthority?: Pick<PrismaClient, "$queryRaw">,
  ) {}

  async claim(input: CodexRotatingSetupPayloadClaim) {
    return this.prisma.$transaction(
      async (tx) => {
        const writer = await requireProvenWriter(
          tx,
          undefined,
          undefined,
          this.databaseRecoveryWitness,
        );
        const initial = await findManifest(tx, input.setupNonce);
        await lockCodexRotatingSetupProvider(tx, initial.providerInstanceId);
        await lockCodexRotatingProviderRow(tx, initial.providerInstanceRowId);
        const manifestRow = await findManifest(tx, input.setupNonce);
        const manifest = codexRotatingSetupManifestSchema.parse(
          manifestRow.manifestJson,
        );
        if (
          manifestRow.databaseRecoveryWitness !== writer.databaseRecoveryWitness
        ) {
          throw new Error("codex_rotating_setup_recovery_required");
        }
        const now = await this.clock.now(tx);
        const digest = createHash("sha256")
          .update(JSON.stringify(manifest), "utf8")
          .digest("hex");
        if (
          manifest.repositoryId !== input.repositoryId ||
          manifest.providerInstanceId !== input.providerInstanceId ||
          manifest.installer.version !== input.installerVersion ||
          manifest.installer.sha256.toLowerCase() !== input.installerDigest ||
          digest !== input.manifestDigest ||
          manifestRow.mutationEpoch?.toString() !== input.recoveryEpoch ||
          !isCodexRotatingOAuthAllowedForRepository(
            manifest.repositoryFullName,
            this.runtimeEnvironment,
          )
        ) {
          throw new Error("codex_rotating_setup_payload_claim_mismatch");
        }
        if (!(await isCodexRotatingSetupFenceOwner(tx, manifestRow))) {
          throw new Error("codex_rotating_setup_confirmation_stale_epoch");
        }
        if (
          manifestRow.status !== "fetched" ||
          !manifestRow.recoveryExpiresAt ||
          manifestRow.recoveryExpiresAt <= now
        ) {
          throw new Error("codex_rotating_setup_payload_claim_expired");
        }

        const recoveryAssociation = await findManifestRecoveryAssociation(
          tx,
          manifestRow.providerInstanceRowId,
          manifestRow.id,
          BigInt(input.recoveryEpoch),
        );

        const existing = await findClaimByOperationOrEpoch(tx, input);
        if (existing) {
          if (!isCodexRotatingSetupLiveClaimStatus(existing.status)) {
            throw new Error("codex_rotating_setup_recovery_required");
          }
          if (existing.status === "active") {
            throw new Error("codex_rotating_setup_confirmation_stale_epoch");
          }
          if (
            existing.status === "prepared" &&
            existing.prepareReplayExpiresAt <= now
          ) {
            throw new Error("codex_rotating_setup_payload_claim_expired");
          }
          if (
            !codexRotatingSetupPayloadClaimsMatch(
              toDomainClaim(existing, input),
              input,
            ) ||
            existing.recoveryRequestId !==
              (recoveryAssociation?.recoveryRequestId ?? null)
          ) {
            throw new Error("codex_rotating_setup_payload_claim_conflict");
          }
          return claimResult(
            existing,
            existing.status === "prepared"
              ? "prepared_replay"
              : existing.status,
          );
        }

        const priorIdentity = await tx.$queryRaw<
          Array<{ accountIdentityHash: string }>
        >`
          SELECT "accountIdentityHash"
          FROM "CodexOAuthSetupPayloadClaim"
          WHERE "providerInstanceRowId" = ${manifestRow.providerInstanceRowId}
            AND "status" IN (${Prisma.join(
              codexRotatingSetupIdentityBearingClaimStatuses,
            )})
          ORDER BY "recoveryEpoch" DESC, "createdAt" DESC, "id" DESC
          LIMIT 1
        `;
        if (
          priorIdentity[0] &&
          priorIdentity[0].accountIdentityHash !== input.accountIdentityHash
        ) {
          const accountSwitch = await tx.$queryRaw<Array<{ allowed: boolean }>>`
            SELECT EXISTS (
              SELECT 1
              FROM "CodexOAuthSetupRecoveryRequest"
              WHERE "latestManifestId" = ${manifestRow.id}
                AND "mutationEpoch" = ${BigInt(input.recoveryEpoch) - 1n}
                AND "mode" = 'forced_reseed_account_switch'
                AND "state" = 'manifest_issued'
            ) AS "allowed"
          `;
          assertCodexRotatingAccountIdentityTransition({
            priorAccountIdentityHash:
              priorIdentity[0]?.accountIdentityHash ?? null,
            nextAccountIdentityHash: input.accountIdentityHash,
            recoveryMode:
              accountSwitch[0]?.allowed === true
                ? "forced_reseed_account_switch"
                : null,
          });
        }

        // This server-generated UUID v4 is the continuation bearer capability:
        // six structural bits are fixed, leaving 122 unpredictable bits.
        const claimId = `codex_claim_${randomUUID()}`;
        // Admission of a later recovery epoch is also the durable cleanup path
        // when the old local journal was lost or tampered. Any earlier dispatch
        // authorization may have reached GitHub and is tombstoned, never reused.
        const priorAuthorized = await tx.$queryRaw<
          Array<{ id: string; namespaceId: string }>
        >`
        SELECT a."id", a."namespaceId"
        FROM "CodexOAuthSetupDispatchAttempt" a
        JOIN "CodexOAuthSetupPayloadClaim" c ON c."id" = a."claimId"
        WHERE c."providerInstanceRowId" = ${manifestRow.providerInstanceRowId}
          AND a."status" = 'dispatch_authorized'
        FOR UPDATE OF a
      `;
        for (const attempt of priorAuthorized) {
          await retireAttemptAndNamespace(
            tx,
            attempt.id,
            attempt.namespaceId,
            now,
            {
              providerInstanceRowId: manifestRow.providerInstanceRowId,
              ownerId: manifestRow.id,
              epoch: manifestRow.mutationEpoch!,
            },
          );
        }
        const prepareReplayExpiresAt = new Date(
          Math.min(
            manifestRow.recoveryExpiresAt.getTime(),
            now.getTime() + 15 * 60 * 1000,
          ),
        );
        await tx.$executeRaw`
        INSERT INTO "CodexOAuthSetupPayloadClaim" (
          "id", "providerInstanceRowId", "workspaceId", "repositoryId",
          "githubRepositoryId", "manifestId", "manifestDigest", "recoveryRequestId", "recoveryEpoch",
          "operationId", "payloadVersion", "canonicalizationVersion", "generationHash",
          "accountIdentityHash", "accountIdentityAlgorithm", "authByteSize",
          "installerVersion", "installerDigest", "databaseIncarnation", "databaseRecoveryWitness", "status", "prepareReplayExpiresAt",
          "recoveryExpiresAt", "createdAt", "updatedAt"
        ) VALUES (
          ${claimId}, ${manifestRow.providerInstanceRowId}, ${manifestRow.workspaceId},
          ${manifestRow.repositoryId}, ${input.repositoryId}, ${manifestRow.id},
          ${input.manifestDigest}, ${recoveryAssociation?.recoveryRequestId ?? null}, ${BigInt(input.recoveryEpoch)}, ${input.operationId},
          ${input.payloadVersion}, ${input.canonicalizationVersion}, ${input.generationHash},
          ${input.accountIdentityHash}, ${input.accountIdentityAlgorithm}, ${input.authByteSize},
          ${input.installerVersion}, ${input.installerDigest}, ${writer.databaseIncarnation}, ${writer.databaseRecoveryWitness}, 'prepared',
          ${prepareReplayExpiresAt}, ${manifestRow.recoveryExpiresAt}, ${now}, ${now}
        )
      `;
        const created = await findClaim(tx, claimId);
        return claimResult(created, "prepared");
      },
      { timeout: transactionTimeoutMs },
    );
  }

  async authorizeDispatch(input: { claimId: string; idempotencyKey: string }) {
    const result = await this.prisma.$transaction(
      async (tx) => {
        const initial = await findClaim(tx, input.claimId);
        await requireProvenWriter(
          tx,
          initial.databaseIncarnation,
          initial.databaseRecoveryWitness,
          this.databaseRecoveryWitness,
        );
        await lockCodexRotatingProviderRow(tx, initial.providerInstanceRowId);
        const claim = await findClaimForUpdate(tx, input.claimId);
        assertClaimNotRetired(claim.status);
        const now = await this.clock.now(tx);
        await assertClaimOwnsSetupFence(tx, claim, now);
        const replay = await findAttemptByKey(
          tx,
          input.claimId,
          input.idempotencyKey,
        );
        if (replay) {
          if (replay.dispatchExpiresAt <= now) {
            if (replay.status === "dispatch_authorized") {
              await retireAttemptAndNamespace(
                tx,
                replay.attemptId,
                replay.namespaceId,
                now,
                setupFenceForClaim(claim),
              );
            }
            return expiredDispatchRetired;
          }
          return attemptResult(replay);
        }
        if (claim.status !== "prepared" || claim.recoveryExpiresAt <= now) {
          throw new Error(
            claim.status === "prepared"
              ? "codex_rotating_setup_payload_claim_expired"
              : "codex_rotating_setup_already_confirmed",
          );
        }
        const attempts = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count FROM "CodexOAuthSetupDispatchAttempt"
        WHERE "claimId" = ${claim.id}
      `;
        const ordinal = Number(attempts[0]?.count ?? 0n) + 1;
        if (ordinal > maximumAttempts)
          throw new Error("codex_rotating_setup_attempt_limit");

        // A previous authorization may already have dispatched. It is therefore
        // terminal before a replacement name is allocated, even if it expired or
        // the client claims it never reached GitHub.
        await retireAuthorizedAttempts(tx, claim, now);
        const epochRows = await tx.$queryRaw<Array<{ epoch: bigint }>>`
        SELECT COALESCE(max("namespaceEpoch"), 0)::bigint + 1 AS epoch
        FROM "CodexOAuthSecretNamespace"
        WHERE "providerInstanceRowId" = ${claim.providerInstanceRowId}
      `;
        const namespaceEpoch = epochRows[0]!.epoch;
        const allocated = allocateVersionedProviderSecretNamespace({
          scope: {
            repositoryId: claim.githubRepositoryId,
            providerInstanceId: await findProviderInstanceId(
              tx,
              claim.providerInstanceRowId,
            ),
          },
          epoch: namespaceEpoch,
        });
        const namespaceId = allocated.namespaceId;
        const attemptId = `codex_attempt_${randomUUID()}`;
        const secretName = allocated.name;
        const dispatchExpiresAt =
          reserveCodexRotatingSetupDispatchAuthorityWindow(now);
        await tx.$executeRaw`
        INSERT INTO "CodexOAuthSecretNamespace" (
          "id", "providerInstanceRowId", "githubRepositoryId", "namespaceEpoch",
          "secretName", "databaseRecoveryWitness", "status", "createdAt"
        ) VALUES (${namespaceId}, ${claim.providerInstanceRowId}, ${claim.githubRepositoryId},
          ${namespaceEpoch}, ${secretName}, ${claim.databaseRecoveryWitness}, 'dispatch_authorized', ${now})
      `;
        await tx.$executeRaw`
        INSERT INTO "CodexOAuthSetupDispatchAttempt" (
          "id", "claimId", "namespaceId", "ordinal", "idempotencyKey", "status",
          "authorizedAt", "dispatchExpiresAt", "createdAt", "updatedAt"
        ) VALUES (${attemptId}, ${claim.id}, ${namespaceId}, ${ordinal},
          ${input.idempotencyKey}, 'dispatch_authorized', ${now}, ${dispatchExpiresAt}, ${now}, ${now})
      `;
        return {
          claimId: claim.id,
          attemptId,
          namespaceId,
          namespaceEpoch: namespaceEpoch.toString(),
          secretName,
          status: "dispatch_authorized" as const,
          dispatchExpiresAt: dispatchExpiresAt.toISOString(),
        };
      },
      { timeout: transactionTimeoutMs },
    );
    if (result === expiredDispatchRetired) {
      throw new Error("codex_rotating_setup_dispatch_expired");
    }
    return result;
  }

  async recordDispatchOutcome(input: {
    claimId: string;
    attemptId: string;
    outcome: "definite_success" | "unknown";
    responseCode?: 201 | 204;
  }) {
    const result = await this.prisma.$transaction(
      async (tx) => {
        const initial = await findClaim(tx, input.claimId);
        await requireProvenWriter(
          tx,
          initial.databaseIncarnation,
          initial.databaseRecoveryWitness,
          this.databaseRecoveryWitness,
        );
        await lockCodexRotatingProviderRow(tx, initial.providerInstanceRowId);
        const claim = await findClaimForUpdate(tx, input.claimId);
        assertClaimNotRetired(claim.status);
        const now = await this.clock.now(tx);
        await assertClaimOwnsSetupFence(tx, claim, now);
        const attempt = await findAttemptForUpdate(
          tx,
          input.claimId,
          input.attemptId,
        );
        if (attempt.status === "retired_ambiguous") {
          if (input.outcome === "unknown")
            return { status: "retired_ambiguous" as const };
          throw new Error("codex_rotating_setup_namespace_retired");
        }
        if (attempt.dispatchExpiresAt <= now) {
          if (attempt.status === "dispatch_authorized") {
            await retireAttemptAndNamespace(
              tx,
              attempt.attemptId,
              attempt.namespaceId,
              now,
              setupFenceForClaim(claim),
            );
          }
          return expiredDispatchRetired;
        }
        if (attempt.status === "confirmed") {
          if (input.outcome === "definite_success")
            return { status: "confirmed_candidate" as const };
          throw new Error("codex_rotating_setup_attempt_already_confirmed");
        }
        if (input.outcome === "unknown") {
          await retireAttemptAndNamespace(
            tx,
            attempt.attemptId,
            attempt.namespaceId,
            now,
            setupFenceForClaim(claim),
          );
          return { status: "retired_ambiguous" as const };
        }
        if (
          claim.confirmedAttemptId &&
          claim.confirmedAttemptId !== attempt.attemptId
        ) {
          throw new Error("codex_rotating_setup_confirmation_conflict");
        }
        // The database receipt is transaction-, backend-, role-, owner-, and
        // response-bound. The following guarded updates cannot be reproduced
        // by direct table DML under the web runtime login.
        if (!this.databaseEffectAuthority) {
          throw new Error("codex_oauth_database_effect_authority_unavailable");
        }
        const databaseAuthoritySignature = await signDatabaseAuthorityChallenge(
          {
            tx,
            authority: this.databaseEffectAuthority,
            effect: "setup_confirmation",
            ownerId: attempt.attemptId,
            effectCode: input.responseCode!,
          },
        );
        await tx.$executeRaw`
          SELECT "codex_oauth_authorize_setup_confirmation"(
            ${attempt.attemptId}, ${input.responseCode!},
            ${databaseAuthoritySignature}
          )
        `;
        const confirmedAttempt = await tx.$executeRaw`
        UPDATE "CodexOAuthSetupDispatchAttempt"
        SET "status" = 'confirmed', "definiteResponseCode" = ${input.responseCode!},
            "confirmedAt" = ${now}, "updatedAt" = ${now}
        WHERE "id" = ${attempt.attemptId} AND "status" = 'dispatch_authorized'
      `;
        const confirmedNamespace = await tx.$executeRaw`
        UPDATE "CodexOAuthSecretNamespace"
        SET "status" = 'confirmed_candidate', "confirmedAt" = ${now}
        WHERE "id" = ${attempt.namespaceId} AND "status" = 'dispatch_authorized'
      `;
        const confirmedClaim = await tx.$executeRaw`
        UPDATE "CodexOAuthSetupPayloadClaim"
        SET "status" = 'confirmed_candidate', "confirmedAttemptId" = ${attempt.attemptId},
            "confirmedAt" = ${now}, "updatedAt" = ${now}
        WHERE "id" = ${claim.id} AND "status" = 'prepared'
      `;
        const transitionedProvider = await tx.$executeRaw`
        UPDATE "CodexOAuthProviderInstance"
        SET "state" = 'workflow_update_required', "updatedAt" = ${now}
        WHERE "id" = ${claim.providerInstanceRowId}
          AND "mutationOwner" = 'setup'
          AND "mutationOwnerId" = ${claim.manifestId}
          AND "mutationEpoch" = ${claim.recoveryEpoch}
      `;
        if (
          confirmedAttempt !== 1 ||
          confirmedNamespace !== 1 ||
          confirmedClaim !== 1 ||
          transitionedProvider !== 1
        ) {
          throw new Error("codex_rotating_setup_confirmation_stale_epoch");
        }
        return { status: "confirmed_candidate" as const };
      },
      { timeout: transactionTimeoutMs },
    );
    if (result === expiredDispatchRetired) {
      throw new Error("codex_rotating_setup_dispatch_expired");
    }
    return result;
  }

  async status(claimId: string): Promise<CodexRotatingSetupStatus> {
    return this.prisma.$transaction(
      async (tx) => {
        const claim = await findClaim(tx, claimId);
        const writer = await requireProvenWriter(
          tx,
          claim.databaseIncarnation,
          claim.databaseRecoveryWitness,
          this.databaseRecoveryWitness,
        );
        const attempts = await tx.$queryRaw<AttemptRow[]>`
      SELECT a."claimId", a."id" AS "attemptId", a."namespaceId", n."namespaceEpoch",
             n."secretName", a."status", a."dispatchExpiresAt"
      FROM "CodexOAuthSetupDispatchAttempt" a
      JOIN "CodexOAuthSecretNamespace" n ON n."id" = a."namespaceId"
      WHERE a."claimId" = ${claimId}
      ORDER BY a."ordinal" DESC LIMIT 1
    `;
        return {
          status: claim.status,
          claimId: claim.id,
          databaseIncarnation: writer.databaseIncarnation,
          databaseRecoveryWitnessFingerprint: writer.databaseRecoveryWitness,
          attempt: attempts[0] ? attemptResult(attempts[0]) : null,
        };
      },
      { timeout: transactionTimeoutMs },
    );
  }

  async activate(input: CodexRotatingActivation) {
    return this.prisma.$transaction(
      async (tx) => {
        const initial = await findClaim(tx, input.claimId);
        await requireProvenWriter(
          tx,
          initial.databaseIncarnation,
          initial.databaseRecoveryWitness,
          this.databaseRecoveryWitness,
        );
        await lockCodexRotatingProviderRow(tx, initial.providerInstanceRowId);
        const claim = await findClaimForUpdate(tx, input.claimId);
        assertClaimNotRetired(claim.status);
        const attempt = await findAttemptForUpdate(
          tx,
          input.claimId,
          input.attemptId,
        );
        const now = await this.clock.now(tx);
        await assertClaimOwnsSetupFence(tx, claim, now);
        if (
          claim.status !== "confirmed_candidate" ||
          attempt.status !== "confirmed" ||
          attempt.namespaceId !== input.namespaceId ||
          attempt.namespaceEpoch.toString() !== input.namespaceEpoch ||
          attempt.secretName !== input.secretName ||
          claim.githubRepositoryId !== input.repositoryId
        )
          throw new Error("codex_rotating_setup_activation_mismatch");
        await tx.$executeRaw`
        UPDATE "CodexOAuthSetupDispatchAttempt"
        SET "status" = 'retired_confirmed', "retiredAt" = ${now},
            "updatedAt" = ${now}
        WHERE "claimId" IN (
          SELECT "id" FROM "CodexOAuthSetupPayloadClaim"
          WHERE "providerInstanceRowId" = ${claim.providerInstanceRowId}
            AND "status" = 'active'
        )
          AND "status" = 'confirmed'
      `;
        await tx.$executeRaw`
        UPDATE "CodexOAuthSetupPayloadClaim"
        SET "status" = 'retired_active', "updatedAt" = ${now}
        WHERE "providerInstanceRowId" = ${claim.providerInstanceRowId}
          AND "status" = 'active'
      `;
        await tx.$executeRaw`
        UPDATE "CodexOAuthSecretNamespace"
        SET "status" = 'retired_superseded', "permanentlyRetired" = true,
            "retiredAt" = ${now}
        WHERE "providerInstanceRowId" = ${claim.providerInstanceRowId}
          AND "status" = 'active' AND "id" <> ${input.namespaceId}
      `;
        const activatedNamespace = await tx.$executeRaw`
        UPDATE "CodexOAuthSecretNamespace" SET "status" = 'active',
          "workflowPath" = ${input.workflowPath},
          "workflowSourceCommitSha" = ${input.workflowSourceCommitSha},
          "workflowSourceBlobSha" = ${input.workflowSourceBlobSha},
          "workflowSourceSha256" = ${input.workflowSourceSha256},
          "workflowSemanticSha256" = ${input.workflowSemanticSha256},
          "workflowSourceTrust" = ${input.sourceTrust},
          "workflowSchemaVersion" = ${input.workflowSchemaVersion},
          "attestedRepositoryId" = ${input.repositoryId},
          "activatedAt" = ${now} WHERE "id" = ${input.namespaceId} AND "status" = 'confirmed_candidate'
      `;
        if (activatedNamespace !== 1) {
          throw new Error("codex_rotating_setup_activation_mismatch");
        }
        const activatedProvider = await tx.$executeRaw`
        UPDATE "CodexOAuthProviderInstance" SET "activeSecretNamespaceId" = ${input.namespaceId},
          "activeSecretNamespaceEpoch" = ${BigInt(input.namespaceEpoch)},
          "activeSecretNamespaceName" = ${input.secretName},
          "activeAccountIdentityHash" = ${claim.accountIdentityHash},
          "latestGeneration" = CASE WHEN "latestGenerationHash" IS NULL
            THEN "latestGeneration" ELSE "latestGeneration" + 1 END,
          "latestGenerationHash" = ${claim.generationHash}, "state" = 'active',
          "mutationEpoch" = "mutationEpoch" + 1, "updatedAt" = ${now}
        WHERE "id" = ${claim.providerInstanceRowId}
          AND "mutationOwner" = 'setup'
          AND "mutationOwnerId" = ${claim.manifestId}
          AND "mutationEpoch" = ${claim.recoveryEpoch}
      `;
        if (activatedProvider !== 1)
          throw new Error("codex_rotating_setup_activation_stale_epoch");
        const releasedProviderFence = await tx.$executeRaw`
        UPDATE "CodexOAuthProviderInstance"
        SET "mutationOwner" = NULL, "mutationOwnerId" = NULL, "updatedAt" = ${now}
        WHERE "id" = ${claim.providerInstanceRowId}
          AND "mutationOwner" = 'setup'
          AND "mutationOwnerId" = ${claim.manifestId}
          AND "mutationEpoch" = ${claim.recoveryEpoch + 1n}
      `;
        if (releasedProviderFence !== 1)
          throw new Error("codex_rotating_setup_activation_stale_epoch");
        const activatedClaim = await tx.$executeRaw`
        UPDATE "CodexOAuthSetupPayloadClaim" SET "status" = 'active', "activatedAt" = ${now},
          "updatedAt" = ${now} WHERE "id" = ${claim.id}
          AND "status" = 'confirmed_candidate'
          AND "confirmedAttemptId" = ${attempt.attemptId}
      `;
        const consumedManifest = await tx.$executeRaw`
        UPDATE "CodexOAuthSetupManifest" SET "status" = 'consumed', "consumedAt" = ${now}
        WHERE "id" = ${claim.manifestId} AND "status" = 'fetched'
      `;
        if (activatedClaim !== 1 || consumedManifest !== 1) {
          throw new Error("codex_rotating_setup_activation_stale_epoch");
        }
        await completeSetupRecoveryAssociation(tx, claim, now);
        return { status: "active" as const };
      },
      { timeout: transactionTimeoutMs },
    );
  }

  /**
   * Re-attests the workflow source for an unchanged active namespace. This is
   * used when a canonical workflow schema is upgraded without rotating the
   * provider secret generation.
   */
  async readActiveWorkflowAttestation(
    namespace: VersionedProviderSecretNamespace,
  ) {
    const row = await this.prisma.codexOAuthSecretNamespace.findUnique({
      where: { id: namespace.namespaceId },
      select: {
        githubRepositoryId: true,
        workflowPath: true,
        workflowSourceCommitSha: true,
        workflowSourceBlobSha: true,
        workflowSourceSha256: true,
        workflowSemanticSha256: true,
        workflowSourceTrust: true,
        workflowSchemaVersion: true,
        attestedRepositoryId: true,
      },
    });
    if (
      !row ||
      row.githubRepositoryId !== namespace.scope.repositoryId ||
      row.attestedRepositoryId !== namespace.scope.repositoryId ||
      !row.workflowPath ||
      !row.workflowSourceCommitSha ||
      !row.workflowSourceBlobSha ||
      !row.workflowSourceSha256 ||
      !row.workflowSemanticSha256 ||
      row.workflowSourceTrust !==
        WorkflowSourceTrust.TrustedDefaultBranchRevision ||
      row.workflowSchemaVersion === null
    ) {
      return null;
    }
    return createVersionedSecretWorkflowSourceAttestation({
      repositoryId: row.attestedRepositoryId,
      workflowPath: row.workflowPath,
      workflowSourceCommitSha: row.workflowSourceCommitSha,
      workflowSourceBlobSha: row.workflowSourceBlobSha,
      workflowSourceSha256: row.workflowSourceSha256,
      workflowSemanticSha256: row.workflowSemanticSha256,
      sourceTrust: row.workflowSourceTrust,
      workflowSchemaVersion: row.workflowSchemaVersion,
      secretNamespace: namespace,
    });
  }

  async replaceActiveWorkflowSource(
    transition: CodexRotatingWorkflowReattestationTransition,
  ) {
    const { target, expectedCurrent, replacement } = transition;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const initial = await findClaim(tx, target.claimId);
          await requireProvenWriter(
            tx,
            initial.databaseIncarnation,
            initial.databaseRecoveryWitness,
            this.databaseRecoveryWitness,
          );
          await lockCodexRotatingProviderRow(tx, initial.providerInstanceRowId);
          const claim = await findClaimForUpdate(tx, target.claimId);
          const attempt = await findAttemptForUpdate(
            tx,
            target.claimId,
            target.attemptId,
          );
          if (
            claim.status !== "active" ||
            attempt.status !== "confirmed" ||
            claim.githubRepositoryId !== target.repositoryId
          ) {
            throw new Error("codex_rotating_setup_activation_mismatch");
          }
          await tx.$executeRaw`
            SELECT "codex_oauth_reattest_active_namespace_v4_to_v5"(
              ${claim.providerInstanceRowId}, ${claim.id}, ${attempt.attemptId},
              ${target.namespace.namespaceId}, ${target.namespace.epoch}, ${target.namespace.name},
              ${target.repositoryId}, ${target.expectedGenerationHash}, ${target.workflowPath},
              ${replacement.sourceTrust}, ${expectedCurrent.workflowSchemaVersion},
              ${replacement.workflowSchemaVersion},
              ${expectedCurrent.workflowSourceCommitSha},
              ${expectedCurrent.workflowSourceBlobSha},
              ${expectedCurrent.workflowSourceSha256},
              ${expectedCurrent.workflowSemanticSha256},
              ${replacement.workflowSourceCommitSha}, ${replacement.workflowSourceBlobSha},
              ${replacement.workflowSourceSha256}, ${replacement.workflowSemanticSha256}
            )
          `;
          return { status: "active" as const };
        },
        { timeout: transactionTimeoutMs },
      );
    } catch (error) {
      throw translateWorkflowReattestationDatabaseError(error);
    }
  }

  async retireProviderGeneration(
    input: CodexRotatingSetupRecoveryFence,
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await lockCodexRotatingSetupProvider(tx, input.providerInstanceId);
        const provider = await tx.codexOAuthProviderInstance.findUnique({
          where: { providerInstanceId: input.providerInstanceId },
          select: {
            id: true,
            mutationOwner: true,
            mutationOwnerId: true,
            mutationEpoch: true,
          },
        });
        if (!provider) throw new Error("codex_rotating_provider_not_found");
        await lockCodexRotatingProviderRow(tx, provider.id);
        const locked = await tx.codexOAuthProviderInstance.findUniqueOrThrow({
          where: { id: provider.id },
          select: {
            mutationOwner: true,
            mutationOwnerId: true,
            mutationEpoch: true,
          },
        });
        if (
          locked.mutationOwner !== "recovery" ||
          locked.mutationOwnerId !==
            `setup-recovery:${input.recoveryRequestId}` ||
          locked.mutationEpoch !== input.recoveryEpoch
        ) {
          throw new Error("codex_rotating_setup_recovery_required");
        }
        await retirePriorNamespaceGeneration(tx, {
          providerInstanceRowId: provider.id,
          now: await this.clock.now(tx),
        });
      },
      { timeout: transactionTimeoutMs },
    );
  }
}

function assertClaimNotRetired(status: CodexRotatingSetupClaimStatus): void {
  if (isCodexRotatingSetupTerminalClaimStatus(status)) {
    throw new Error("codex_rotating_setup_namespace_retired");
  }
}

export async function completeSetupRecoveryAssociation(
  tx: Prisma.TransactionClient,
  claim: Pick<
    ClaimRow,
    | "providerInstanceRowId"
    | "recoveryRequestId"
    | "recoveryEpoch"
    | "manifestId"
  >,
  now: Date,
): Promise<void> {
  if (claim.recoveryRequestId === null) {
    const recoveryAssociations = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "CodexOAuthSetupRecoveryRequest"
      WHERE "providerInstanceRowId" = ${claim.providerInstanceRowId}
        AND "latestManifestId" = ${claim.manifestId}
      FOR UPDATE
    `;
    if (recoveryAssociations.length !== 0) {
      throw new Error("codex_rotating_setup_recovery_association_conflict");
    }
    return;
  }
  const completedRecoveryRequests = await tx.$executeRaw`
    UPDATE "CodexOAuthSetupRecoveryRequest" SET "state" = 'completed',
      "completedAt" = ${now}, "updatedAt" = ${now}
    WHERE "providerInstanceRowId" = ${claim.providerInstanceRowId}
      AND "recoveryRequestId" = ${claim.recoveryRequestId}
      AND "mutationEpoch" = ${claim.recoveryEpoch - 1n}
      AND "latestManifestId" = ${claim.manifestId}
      AND "state" = 'manifest_issued'
  `;
  if (completedRecoveryRequests !== 1) {
    throw new Error("codex_rotating_setup_recovery_transition_conflict");
  }
}

async function findManifest(
  tx: Prisma.TransactionClient,
  setupNonce: string,
): Promise<ManifestRow> {
  const rows = await tx.$queryRaw<ManifestRow[]>`
    SELECT "id", "workspaceId", "repositoryId", "providerInstanceRowId", "providerInstanceId",
      "setupNonce", "manifestJson", "status", "mutationEpoch",
      "databaseRecoveryWitness", "recoveryExpiresAt"
    FROM "CodexOAuthSetupManifest" WHERE "setupNonce" = ${setupNonce} LIMIT 1
  `;
  if (!rows[0]) throw new Error("codex_rotating_setup_manifest_not_found");
  return rows[0];
}

type ManifestRecoveryAssociationRow = {
  readonly recoveryRequestId: string;
  readonly providerInstanceRowId: string;
  readonly mutationEpoch: bigint;
  readonly state: string;
};

async function findManifestRecoveryAssociation(
  tx: Prisma.TransactionClient,
  providerInstanceRowId: string,
  manifestId: string,
  mutationEpoch: bigint,
): Promise<ManifestRecoveryAssociationRow | null> {
  const rows = await tx.$queryRaw<ManifestRecoveryAssociationRow[]>`
    SELECT "recoveryRequestId", "providerInstanceRowId", "mutationEpoch", "state"
    FROM "CodexOAuthSetupRecoveryRequest"
    WHERE "latestManifestId" = ${manifestId}
    FOR UPDATE
  `;
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (
    rows.length !== 1 ||
    row.providerInstanceRowId !== providerInstanceRowId ||
    row.mutationEpoch + 1n !== mutationEpoch ||
    row.state !== "manifest_issued"
  ) {
    throw new Error("codex_rotating_setup_recovery_association_conflict");
  }
  return row;
}

async function findClaim(
  tx: Prisma.TransactionClient | PrismaClient,
  id: string,
): Promise<ClaimRow> {
  const rows = await tx.$queryRaw<ClaimRow[]>`
    SELECT "id", "providerInstanceRowId", "githubRepositoryId", "manifestId", "manifestDigest", "recoveryRequestId",
      "recoveryEpoch", "operationId", "payloadVersion", "canonicalizationVersion", "generationHash",
      "accountIdentityHash", "accountIdentityAlgorithm", "authByteSize", "installerVersion",
      "installerDigest", "databaseIncarnation", "databaseRecoveryWitness", "status", "claimVersion", "prepareReplayExpiresAt", "recoveryExpiresAt",
      "confirmedAttemptId" FROM "CodexOAuthSetupPayloadClaim" WHERE "id" = ${id} LIMIT 1
  `;
  if (!rows[0]) throw new Error("codex_rotating_setup_claim_not_found");
  return rows[0];
}

async function findClaimForUpdate(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<ClaimRow> {
  const rows = await tx.$queryRaw<ClaimRow[]>`
    SELECT "id", "providerInstanceRowId", "githubRepositoryId", "manifestId", "manifestDigest", "recoveryRequestId",
      "recoveryEpoch", "operationId", "payloadVersion", "canonicalizationVersion", "generationHash",
      "accountIdentityHash", "accountIdentityAlgorithm", "authByteSize", "installerVersion",
      "installerDigest", "databaseIncarnation", "databaseRecoveryWitness", "status", "claimVersion", "prepareReplayExpiresAt", "recoveryExpiresAt",
      "confirmedAttemptId" FROM "CodexOAuthSetupPayloadClaim" WHERE "id" = ${id} LIMIT 1 FOR UPDATE
  `;
  if (!rows[0]) throw new Error("codex_rotating_setup_claim_not_found");
  return rows[0];
}

async function findClaimByOperationOrEpoch(
  tx: Prisma.TransactionClient,
  input: CodexRotatingSetupPayloadClaim,
) {
  const rows = await tx.$queryRaw<ClaimRow[]>`
    SELECT "id", "providerInstanceRowId", "githubRepositoryId", "manifestId", "manifestDigest", "recoveryRequestId",
      "recoveryEpoch", "operationId", "payloadVersion", "canonicalizationVersion", "generationHash",
      "accountIdentityHash", "accountIdentityAlgorithm", "authByteSize", "installerVersion",
      "installerDigest", "databaseIncarnation", "databaseRecoveryWitness", "status", "claimVersion", "prepareReplayExpiresAt", "recoveryExpiresAt",
      "confirmedAttemptId" FROM "CodexOAuthSetupPayloadClaim"
    WHERE "providerInstanceRowId" = (SELECT "providerInstanceRowId" FROM "CodexOAuthSetupManifest" WHERE "setupNonce" = ${input.setupNonce})
      AND ("operationId" = ${input.operationId} OR "recoveryEpoch" = ${BigInt(input.recoveryEpoch)})
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function toDomainClaim(
  row: ClaimRow,
  input: CodexRotatingSetupPayloadClaim,
): CodexRotatingSetupPayloadClaim {
  return {
    payloadVersion: 2,
    canonicalizationVersion: 1,
    operationId: row.operationId,
    repositoryId: row.githubRepositoryId,
    providerInstanceId: input.providerInstanceId,
    setupNonce: input.setupNonce,
    manifestDigest: row.manifestDigest,
    recoveryEpoch: row.recoveryEpoch.toString(),
    generationHash: row.generationHash,
    accountIdentityHash: row.accountIdentityHash,
    accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
    authByteSize: row.authByteSize,
    installerVersion: row.installerVersion,
    installerDigest: row.installerDigest,
  };
}

function claimResult(
  row: ClaimRow,
  status: CodexRotatingSetupClaimAdmissionStatus,
) {
  return {
    status,
    claimId: row.id,
    claimVersion: row.claimVersion,
    prepareReplayExpiresAt: row.prepareReplayExpiresAt.toISOString(),
    recoveryExpiresAt: row.recoveryExpiresAt.toISOString(),
  };
}

async function findAttemptByKey(
  tx: Prisma.TransactionClient,
  claimId: string,
  key: string,
) {
  const rows = await tx.$queryRaw<AttemptRow[]>`
    SELECT a."claimId", a."id" AS "attemptId", a."namespaceId", n."namespaceEpoch",
      n."secretName", a."status", a."dispatchExpiresAt"
    FROM "CodexOAuthSetupDispatchAttempt" a JOIN "CodexOAuthSecretNamespace" n ON n."id" = a."namespaceId"
    WHERE a."claimId" = ${claimId} AND a."idempotencyKey" = ${key}
    LIMIT 1 FOR UPDATE OF a, n
  `;
  return rows[0] ?? null;
}

async function findAttemptForUpdate(
  tx: Prisma.TransactionClient,
  claimId: string,
  attemptId: string,
) {
  const rows = await tx.$queryRaw<AttemptRow[]>`
    SELECT a."claimId", a."id" AS "attemptId", a."namespaceId", n."namespaceEpoch",
      n."secretName", a."status", a."dispatchExpiresAt"
    FROM "CodexOAuthSetupDispatchAttempt" a JOIN "CodexOAuthSecretNamespace" n ON n."id" = a."namespaceId"
    WHERE a."claimId" = ${claimId} AND a."id" = ${attemptId}
    LIMIT 1 FOR UPDATE OF a, n
  `;
  if (!rows[0]) throw new Error("codex_rotating_setup_attempt_not_found");
  return rows[0];
}

async function retireAuthorizedAttempts(
  tx: Prisma.TransactionClient,
  claim: ClaimRow,
  now: Date,
) {
  const rows = await tx.$queryRaw<Array<{ id: string; namespaceId: string }>>`
    SELECT "id", "namespaceId" FROM "CodexOAuthSetupDispatchAttempt"
    WHERE "claimId" = ${claim.id} AND "status" = 'dispatch_authorized' FOR UPDATE
  `;
  for (const row of rows)
    await retireAttemptAndNamespace(
      tx,
      row.id,
      row.namespaceId,
      now,
      setupFenceForClaim(claim),
    );
}

export async function retireAttemptAndNamespace(
  tx: Prisma.TransactionClient,
  attemptId: string,
  namespaceId: string,
  now: Date,
  expectedFence: Readonly<{
    providerInstanceRowId: string;
    ownerId: string;
    epoch: bigint;
  }>,
) {
  const rows = await tx.$queryRaw<
    Array<{
      attemptId: string;
      attemptClaimId: string;
      attemptNamespaceId: string;
      attemptStatus: string;
      attemptRetiredAt: Date | null;
      namespaceProviderInstanceRowId: string;
      namespaceEpoch: bigint;
      namespaceSecretName: string;
      namespaceStatus: string;
      namespacePermanentlyRetired: boolean;
      namespaceRetiredAt: Date | null;
      claimProviderInstanceRowId: string;
      claimRecoveryEpoch: bigint;
      claimManifestId: string;
      providerMutationOwner: string | null;
      providerMutationOwnerId: string | null;
      providerMutationEpoch: bigint;
    }>
  >`
    SELECT attempt."id" AS "attemptId", attempt."claimId" AS "attemptClaimId",
      attempt."namespaceId" AS "attemptNamespaceId", attempt."status" AS "attemptStatus",
      attempt."retiredAt" AS "attemptRetiredAt",
      namespace."providerInstanceRowId" AS "namespaceProviderInstanceRowId",
      namespace."namespaceEpoch", namespace."secretName" AS "namespaceSecretName",
      namespace."status" AS "namespaceStatus",
      namespace."permanentlyRetired" AS "namespacePermanentlyRetired",
      namespace."retiredAt" AS "namespaceRetiredAt",
      claim."providerInstanceRowId" AS "claimProviderInstanceRowId",
      claim."recoveryEpoch" AS "claimRecoveryEpoch", claim."manifestId" AS "claimManifestId",
      provider."mutationOwner" AS "providerMutationOwner",
      provider."mutationOwnerId" AS "providerMutationOwnerId",
      provider."mutationEpoch" AS "providerMutationEpoch"
    FROM "CodexOAuthSetupDispatchAttempt" attempt
    JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = attempt."namespaceId"
    JOIN "CodexOAuthSetupPayloadClaim" claim ON claim."id" = attempt."claimId"
    JOIN "CodexOAuthProviderInstance" provider ON provider."id" = claim."providerInstanceRowId"
    WHERE attempt."id" = ${attemptId} AND namespace."id" = ${namespaceId}
    FOR UPDATE OF attempt, namespace, claim, provider
  `;
  const row = rows[0];
  if (
    !row ||
    row.attemptId !== attemptId ||
    row.attemptNamespaceId !== namespaceId ||
    row.claimProviderInstanceRowId !== expectedFence.providerInstanceRowId ||
    row.namespaceProviderInstanceRowId !== row.claimProviderInstanceRowId ||
    row.providerMutationOwner !== "setup" ||
    row.providerMutationOwnerId !== expectedFence.ownerId ||
    row.providerMutationEpoch !== expectedFence.epoch ||
    row.claimRecoveryEpoch > expectedFence.epoch
  ) {
    throw new Error("codex_rotating_setup_retirement_conflict");
  }
  if (
    row.attemptStatus === "retired_ambiguous" &&
    row.attemptRetiredAt &&
    row.namespaceStatus === "retired_ambiguous" &&
    row.namespacePermanentlyRetired &&
    row.namespaceRetiredAt
  ) {
    return;
  }
  if (
    row.attemptStatus !== "dispatch_authorized" ||
    row.attemptRetiredAt ||
    row.namespaceStatus !== "dispatch_authorized" ||
    row.namespacePermanentlyRetired ||
    row.namespaceRetiredAt
  ) {
    throw new Error("codex_rotating_setup_retirement_conflict");
  }
  const retiredAttempt = await tx.$executeRaw`
    UPDATE "CodexOAuthSetupDispatchAttempt"
    SET "status" = 'retired_ambiguous', "retiredAt" = ${now}, "updatedAt" = ${now}
    WHERE "id" = ${row.attemptId} AND "claimId" = ${row.attemptClaimId}
      AND "namespaceId" = ${namespaceId} AND "status" = 'dispatch_authorized'
      AND "retiredAt" IS NULL
  `;
  const retiredNamespace = await tx.$executeRaw`
    UPDATE "CodexOAuthSecretNamespace"
    SET "status" = 'retired_ambiguous', "permanentlyRetired" = true,
        "retiredAt" = ${now}
    WHERE "id" = ${namespaceId}
      AND "providerInstanceRowId" = ${row.namespaceProviderInstanceRowId}
      AND "namespaceEpoch" = ${row.namespaceEpoch}
      AND "secretName" = ${row.namespaceSecretName}
      AND "status" = 'dispatch_authorized'
      AND NOT "permanentlyRetired" AND "retiredAt" IS NULL
  `;
  if (retiredAttempt !== 1 || retiredNamespace !== 1) {
    throw new Error("codex_rotating_setup_retirement_conflict");
  }
}

function setupFenceForClaim(claim: ClaimRow) {
  return {
    providerInstanceRowId: claim.providerInstanceRowId,
    ownerId: claim.manifestId,
    epoch: claim.recoveryEpoch,
  } as const;
}

function attemptResult(row: AttemptRow): CodexRotatingDispatchAttempt {
  return {
    claimId: row.claimId,
    attemptId: row.attemptId,
    namespaceId: row.namespaceId,
    namespaceEpoch: row.namespaceEpoch.toString(),
    secretName: row.secretName,
    status: row.status,
    dispatchExpiresAt: row.dispatchExpiresAt.toISOString(),
  };
}

async function findProviderInstanceId(
  tx: Prisma.TransactionClient,
  providerInstanceRowId: string,
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ providerInstanceId: string }>>`
    SELECT "providerInstanceId" FROM "CodexOAuthProviderInstance"
    WHERE "id" = ${providerInstanceRowId} LIMIT 1
  `;
  if (!rows[0]) throw new Error("codex_rotating_setup_claim_not_found");
  return rows[0].providerInstanceId;
}

async function assertClaimOwnsSetupFence(
  tx: Prisma.TransactionClient,
  claim: ClaimRow,
  now: Date,
): Promise<void> {
  const providers = await tx.$queryRaw<
    Array<{
      mutationOwner: string | null;
      mutationOwnerId: string | null;
      mutationEpoch: bigint;
    }>
  >`
    SELECT "mutationOwner", "mutationOwnerId", "mutationEpoch"
    FROM "CodexOAuthProviderInstance"
    WHERE "id" = ${claim.providerInstanceRowId}
    FOR UPDATE
  `;
  const manifests = await tx.$queryRaw<
    Array<{
      id: string;
      status: string;
      mutationEpoch: bigint | null;
      recoveryExpiresAt: Date | null;
      manifestJson: unknown;
    }>
  >`
    SELECT "id", "status", "mutationEpoch", "recoveryExpiresAt", "manifestJson"
    FROM "CodexOAuthSetupManifest"
    WHERE "id" = ${claim.manifestId}
    FOR SHARE
  `;
  const provider = providers[0];
  const manifest = manifests[0];
  if (
    !provider ||
    !manifest ||
    manifest.status !== "fetched" ||
    manifest.mutationEpoch !== claim.recoveryEpoch ||
    !manifest.recoveryExpiresAt ||
    manifest.recoveryExpiresAt.getTime() !== claim.recoveryExpiresAt.getTime()
  ) {
    throw new Error("codex_rotating_setup_confirmation_stale_epoch");
  }
  const canonicalManifest = codexRotatingSetupManifestSchema.parse(
    manifest.manifestJson,
  );
  const actualManifestDigest = createHash("sha256")
    .update(JSON.stringify(canonicalManifest), "utf8")
    .digest("hex");
  if (actualManifestDigest !== claim.manifestDigest) {
    throw new Error("codex_rotating_setup_manifest_digest_mismatch");
  }
  try {
    assertProviderSecretTransitionAuthorized({
      expectedOwner: "setup",
      expectedOwnerId: claim.manifestId,
      expectedEpoch: claim.recoveryEpoch,
      actualFence: {
        owner:
          provider.mutationOwner === "setup" ||
          provider.mutationOwner === "runtime" ||
          provider.mutationOwner === "recovery"
            ? provider.mutationOwner
            : null,
        ownerId: provider.mutationOwnerId,
        epoch: provider.mutationEpoch,
      },
      authorizationExpiresAt: claim.recoveryExpiresAt,
      now,
    });
  } catch {
    throw new Error("codex_rotating_setup_confirmation_stale_epoch");
  }
}

async function requireProvenWriter(
  tx: Prisma.TransactionClient,
  expectedIncarnation?: string,
  expectedRecoveryWitness?: string,
  configuredRecoveryWitness?: string,
): Promise<{
  databaseIncarnation: string;
  databaseRecoveryWitness: string;
}> {
  let databaseRecoveryWitness: string;
  try {
    databaseRecoveryWitness = fingerprintDatabaseRecoveryWitness(
      configuredRecoveryWitness ?? "",
    );
  } catch {
    throw new Error("codex_rotating_retryable_uncommitted");
  }
  let rows: Array<{ writer: boolean; databaseIncarnation: string }>;
  try {
    rows = await tx.$queryRaw`
      SELECT NOT pg_is_in_recovery() AS "writer",
             "system_identifier"::text AS "databaseIncarnation"
      FROM pg_control_system()
    `;
  } catch {
    throw new Error("codex_rotating_retryable_uncommitted");
  }
  const proof = rows[0];
  if (
    !proof?.writer ||
    !/^[1-9][0-9]+$/.test(proof.databaseIncarnation) ||
    (expectedIncarnation !== undefined &&
      proof.databaseIncarnation !== expectedIncarnation) ||
    (expectedRecoveryWitness !== undefined &&
      databaseRecoveryWitness !== expectedRecoveryWitness)
  ) {
    throw new Error("codex_rotating_retryable_uncommitted");
  }
  return {
    databaseIncarnation: proof.databaseIncarnation,
    databaseRecoveryWitness,
  };
}
