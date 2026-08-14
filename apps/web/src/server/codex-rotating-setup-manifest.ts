import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  buildCodexRotatingSetupManifest,
  canonicalCodexRotatingProviderId,
  codexRotatingAuthMode,
  codexRotatingSecretName,
  codexRotatingSetupManifestSchema,
  createCodexRotatingSalt,
  encodeCodexRotatingSetupManifest,
  fingerprintDatabaseRecoveryWitness,
  renderCodexRotatingInstallerCommand,
  type CodexRotatingInstallerArgument,
} from "@reviewrouter/features-provider-setup";
import { isCodexRotatingOAuthAllowedForRepository } from "@reviewrouter/platform-config";
import type { CodexRotatingSeedScriptDescriptor } from "./codex-rotating-seed-script";
import {
  isCodexRotatingSetupFenceOwner,
  lockCodexRotatingProviderRow,
  lockCodexRotatingSetupProvider,
} from "./codex-rotating-provider-mutation-fence";

const setupManifestTtlSeconds = 15 * 60;
const setupFetchedRecoveryWindowMs = 24 * 60 * 60 * 1000;
const setupTransactionTimeoutMs = 10_000;

export function assertSetupIssuanceEnabled(
  runtimeEnvironment: NodeJS.ProcessEnv = process.env,
): void {
  if (
    runtimeEnvironment.REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED !==
    "1"
  ) {
    throw new Error("codex_rotating_setup_issuance_quiesced");
  }
}

export enum CodexRotatingSetupManifestStatus {
  Issued = "issued",
  Fetched = "fetched",
  Consumed = "consumed",
  Expired = "expired",
  Superseded = "superseded",
  Recovered = "recovered",
}

type SetupManifestRow = {
  readonly id: string;
  readonly providerInstanceRowId: string;
  readonly providerInstanceId: string;
  readonly repositoryId: string;
  readonly setupNonce: string;
  readonly manifestJson: unknown;
  readonly status: CodexRotatingSetupManifestStatus;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly confirmationJson: unknown | null;
  readonly mutationEpoch: bigint | null;
  readonly databaseRecoveryWitness: string | null;
  readonly recoveryExpiresAt: Date | null;
  readonly payloadVersion: number | null;
  readonly payloadGenerationHash: string | null;
  readonly payloadAccountFingerprint: string | null;
  readonly payloadByteSize: number | null;
  readonly payloadClaimedAt: Date | null;
};

type SetupManifestTransaction = Prisma.TransactionClient;
type SetupManifestQueryClient = Pick<PrismaClient, "$queryRaw">;

export type CodexRotatingSetupAdmittedOperation = (
  tx: SetupManifestTransaction,
) => Promise<void>;

type ForcedRecoveryAuthority = {
  readonly kind: "allocation" | "replay";
  readonly requestId: string;
  readonly epoch: bigint;
  readonly databaseRecoveryWitness: string | null;
  readonly manifestDatabaseRecoveryWitness: string | null;
};

export async function issueCodexRotatingSetupCommand(input: {
  readonly prisma: PrismaClient;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly githubRepositoryId: string;
  readonly installer: CodexRotatingSeedScriptDescriptor;
  readonly setupManifestUrl: string;
  readonly setupPrepareUrl?: string;
  readonly setupDispatchUrl?: string;
  readonly setupDispatchOutcomeUrl?: string;
  readonly setupStatusUrl?: string;
  readonly installerArguments?: readonly CodexRotatingInstallerArgument[];
  readonly databaseRecoveryWitness?: string;
  readonly runtimeEnvironment?: NodeJS.ProcessEnv;
  readonly recovery?: {
    readonly requestId: string;
    readonly epoch: bigint;
  };
  readonly admittedOperation?: CodexRotatingSetupAdmittedOperation;
  readonly now?: Date;
}): Promise<{
  readonly command: string;
  readonly expiresAt: string;
  readonly providerInstanceId: string;
}> {
  assertSetupIssuanceEnabled(input.runtimeEnvironment);
  if (input.recovery && !input.installerArguments?.includes("--force-reseed")) {
    throw new Error("codex_rotating_setup_recovery_force_required");
  }
  const configuredDatabaseRecoveryWitness =
    fingerprintConfiguredSetupRecoveryWitness(input.databaseRecoveryWitness);
  const providerInstanceId = canonicalCodexRotatingProviderId(
    input.githubRepositoryId,
  );
  return input.prisma.$transaction(
    async (tx) => {
      let admittedOperationCompleted = false;
      const runAdmittedOperation = async (): Promise<void> => {
        if (admittedOperationCompleted) return;
        await input.admittedOperation?.(tx);
        admittedOperationCompleted = true;
      };
      await lockCodexRotatingSetupProvider(tx, providerInstanceId);
      let provider = await tx.codexOAuthProviderInstance.findUnique({
        where: {
          repositoryId_authMode: {
            repositoryId: input.repositoryId,
            authMode: codexRotatingAuthMode,
          },
        },
      });
      const providerExisted = provider !== null;
      if (!provider) {
        // A missing provider has no durable witness evidence or row to recheck.
        // Consume admission before the first provider/setup allocation.
        await runAdmittedOperation();
        provider = await tx.codexOAuthProviderInstance.create({
          data: {
            workspaceId: input.workspaceId,
            repositoryId: input.repositoryId,
            providerInstanceId,
            authMode: codexRotatingAuthMode,
            secretName: codexRotatingSecretName,
            generationHashSalt: createCodexRotatingSalt(),
            accountFingerprintSalt: createCodexRotatingSalt(),
          },
        });
      }
      if (
        provider.workspaceId !== input.workspaceId ||
        provider.repositoryId !== input.repositoryId ||
        provider.providerInstanceId !== providerInstanceId ||
        provider.authMode !== codexRotatingAuthMode ||
        provider.secretName !== codexRotatingSecretName
      ) {
        throw new Error("codex_rotating_provider_identity_mismatch");
      }
      // Reject an ordinary W1 -> W2 mismatch before even the bounded row-lock
      // session settings run; the locked recheck below closes the read race.
      const prelockOrdinaryDatabaseRecoveryWitness =
        providerExisted && !input.recovery
          ? await assertCodexRotatingSetupRecoveryWitness(tx, {
              providerInstanceRowId: provider.id,
              ...(input.databaseRecoveryWitness !== undefined
                ? { configuredRecoveryWitness: input.databaseRecoveryWitness }
                : {}),
              forcedRecoveryAuthority: null,
            })
          : null;
      await lockCodexRotatingProviderRow(tx, provider.id);
      provider = await tx.codexOAuthProviderInstance.findUniqueOrThrow({
        where: { id: provider.id },
      });
      const quarantine = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "providerInstanceRowId" AS "id"
        FROM "CodexOAuthProviderIdentityQuarantine"
        WHERE "providerInstanceRowId" = ${provider.id}
          AND "resolvedAt" IS NULL
        LIMIT 1
      `;
      if (quarantine.length > 0) {
        throw new Error("codex_rotating_identity_quarantined");
      }
      const ordinaryDatabaseRecoveryWitness =
        prelockOrdinaryDatabaseRecoveryWitness !== null
          ? await assertCodexRotatingSetupRecoveryWitness(tx, {
              providerInstanceRowId: provider.id,
              ...(input.databaseRecoveryWitness !== undefined
                ? { configuredRecoveryWitness: input.databaseRecoveryWitness }
                : {}),
              forcedRecoveryAuthority: null,
            })
          : null;
      if (ordinaryDatabaseRecoveryWitness !== null) {
        await runAdmittedOperation();
      }
      const now = input.now ?? new Date();
      const activeCandidate = await findActiveSetupManifestForProvider(
        tx,
        provider.id,
      );
      // Match the state that the deferred expiry mutation will expose without
      // writing before forced-recovery witness admission.
      const active =
        activeCandidate?.status === CodexRotatingSetupManifestStatus.Issued &&
        activeCandidate.expiresAt <= now
          ? null
          : activeCandidate;
      const recoveryRequest = input.recovery
        ? await findSetupRecoveryRequest(
            tx,
            provider.id,
            input.recovery.requestId,
          )
        : null;
      const activeRecoveryRequest = await findActiveSetupRecoveryRequest(
        tx,
        provider.id,
      );
      if (
        activeRecoveryRequest &&
        activeRecoveryRequest.id !== recoveryRequest?.id
      ) {
        throw new Error(
          input.recovery
            ? "codex_rotating_setup_recovery_request_conflict"
            : "codex_rotating_setup_recovery_required",
        );
      }
      if (active?.status === CodexRotatingSetupManifestStatus.Fetched) {
        throw new Error("codex_rotating_setup_recovery_required");
      }
      if (provider.mutationOwner === "recovery") {
        if (
          !input.recovery ||
          !recoveryRequest ||
          input.recovery.epoch !== recoveryRequest.mutationEpoch ||
          provider.mutationEpoch !== recoveryRequest.mutationEpoch ||
          provider.mutationOwnerId !==
            `setup-recovery:${input.recovery.requestId}`
        ) {
          throw new Error("codex_rotating_setup_recovery_required");
        }
      } else if (input.recovery) {
        if (
          !recoveryRequest ||
          recoveryRequest.mutationEpoch !== input.recovery.epoch ||
          !isRecoveryRequestMode(recoveryRequest.mode) ||
          !["active", "manifest_issued"].includes(recoveryRequest.state) ||
          provider.mutationOwner !== "setup" ||
          provider.mutationOwnerId !== recoveryRequest.latestManifestId
        ) {
          throw new Error("codex_rotating_setup_recovery_already_used");
        }
      }
      if (
        input.recovery &&
        (!recoveryRequest ||
          !isRecoveryRequestMode(recoveryRequest.mode) ||
          !["active", "manifest_issued"].includes(recoveryRequest.state))
      ) {
        throw new Error("codex_rotating_setup_recovery_already_used");
      }
      const forcedRecoveryAuthority: ForcedRecoveryAuthority | null =
        input.recovery &&
        recoveryRequest &&
        isRecoveryRequestMode(recoveryRequest.mode) &&
        recoveryRequest.mutationEpoch === input.recovery.epoch
          ? recoveryRequest.state === "active" &&
            recoveryRequest.latestManifestId === null &&
            provider.mutationOwner === "recovery" &&
            provider.mutationOwnerId ===
              `setup-recovery:${input.recovery.requestId}` &&
            provider.mutationEpoch === input.recovery.epoch
            ? {
                kind: "allocation",
                requestId: input.recovery.requestId,
                epoch: input.recovery.epoch,
                databaseRecoveryWitness:
                  recoveryRequest.databaseRecoveryWitness,
                manifestDatabaseRecoveryWitness: null,
              }
            : recoveryRequest.state === "manifest_issued" &&
                active?.id === recoveryRequest.latestManifestId &&
                active.mutationEpoch !== null &&
                active.mutationEpoch === provider.mutationEpoch &&
                provider.mutationEpoch === input.recovery.epoch + 1n &&
                provider.mutationOwner === "setup" &&
                provider.mutationOwnerId === active.id
              ? {
                  kind: "replay",
                  requestId: input.recovery.requestId,
                  epoch: input.recovery.epoch,
                  databaseRecoveryWitness:
                    recoveryRequest.databaseRecoveryWitness,
                  manifestDatabaseRecoveryWitness:
                    active.databaseRecoveryWitness,
                }
              : null
          : null;
      if (input.recovery && forcedRecoveryAuthority === null) {
        throw new Error("codex_rotating_setup_recovery_required");
      }
      const databaseRecoveryWitness =
        ordinaryDatabaseRecoveryWitness ??
        (!providerExisted && !input.recovery
          ? configuredDatabaseRecoveryWitness
          : await assertCodexRotatingSetupRecoveryWitness(tx, {
              providerInstanceRowId: provider.id,
              ...(input.databaseRecoveryWitness !== undefined
                ? { configuredRecoveryWitness: input.databaseRecoveryWitness }
                : {}),
              forcedRecoveryAuthority,
            }));
      const blockingIntent = await tx.codexOAuthWritebackIntent.findFirst({
        where: {
          providerInstanceRowId: provider.id,
          OR: [
            { status: "pending" },
            {
              status: "remote_outcome_unknown",
              recoveryResolvedAt: null,
            },
          ],
        },
        select: { id: true },
      });
      if (
        blockingIntent ||
        (provider.mutationOwner === "runtime" &&
          provider.activeLeaseExpiresAt &&
          provider.activeLeaseExpiresAt > now)
      ) {
        throw new Error("codex_rotating_mutation_fence_conflict");
      }

      await runAdmittedOperation();
      await expireActiveSetupManifests(tx, provider.id, now);
      const allocationActive = await findActiveSetupManifestForProvider(
        tx,
        provider.id,
      );
      const parsedActive = allocationActive
        ? codexRotatingSetupManifestSchema.safeParse(
            allocationActive.manifestJson,
          )
        : null;

      let manifest = parsedActive?.success ? parsedActive.data : null;
      if (
        allocationActive &&
        (!manifest ||
          allocationActive.mutationEpoch === null ||
          allocationActive.mutationEpoch !== provider.mutationEpoch ||
          provider.mutationOwner !== "setup" ||
          provider.mutationOwnerId !== allocationActive.id ||
          !isReusableIssuedManifest({
            manifest,
            provider,
            repositoryFullName: input.repositoryFullName,
            githubRepositoryId: input.githubRepositoryId,
            installer: input.installer,
          }))
      ) {
        await supersedeSetupManifest(tx, allocationActive.id);
        manifest = null;
      }

      if (!manifest) {
        const setupNonce = `stp:${randomUUID()}`;
        const manifestId = `codex_setup_${randomUUID()}`;
        const mutationEpoch = provider.mutationEpoch + 1n;
        manifest = buildCodexRotatingSetupManifest({
          repositoryFullName: input.repositoryFullName,
          repositoryId: input.githubRepositoryId,
          providerInstanceId,
          setupNonce,
          installerUrl: input.installer.url,
          installerVersion: input.installer.version,
          installerSha256: input.installer.sha256,
          now,
          ttlSeconds: setupManifestTtlSeconds,
          generationHashSalt: provider.generationHashSalt,
          accountFingerprintSalt: provider.accountFingerprintSalt,
        });
        await tx.codexOAuthProviderInstance.update({
          where: { id: provider.id },
          data: {
            // A reseed can start from an active `ready` provider. Move the
            // provider into the setup lifecycle in the same fenced epoch so
            // confirmation can transition it to `workflow_update_required`.
            state: "setup_pending",
            mutationEpoch,
            mutationOwner: "setup",
            mutationOwnerId: manifestId,
          },
        });
        await tx.$executeRaw`
        INSERT INTO "CodexOAuthSetupManifest" (
          "id",
          "workspaceId",
          "repositoryId",
          "providerInstanceRowId",
          "providerInstanceId",
          "setupNonce",
          "manifestJson",
          "status",
          "expiresAt",
          "mutationEpoch",
          "databaseRecoveryWitness"
        )
        VALUES (
          ${manifestId},
          ${input.workspaceId},
          ${input.repositoryId},
          ${provider.id},
          ${providerInstanceId},
          ${setupNonce},
          CAST(${JSON.stringify(manifest)} AS jsonb),
          ${CodexRotatingSetupManifestStatus.Issued},
          ${new Date(manifest.expiresAt)},
          ${mutationEpoch},
          ${databaseRecoveryWitness}
        )
        `;
        if (recoveryRequest) {
          await transitionRecoveryRequestToManifestIssued(tx, {
            recoveryRequestRowId: recoveryRequest.id,
            providerInstanceRowId: provider.id,
            recoveryRequestId: input.recovery!.requestId,
            recoveryEpoch: input.recovery!.epoch,
            databaseRecoveryWitness,
            manifestId,
            now,
          });
        }
      }

      return setupCommandResult({
        manifest,
        setupManifestUrl: input.setupManifestUrl,
        ...(input.setupPrepareUrl
          ? { setupPrepareUrl: input.setupPrepareUrl }
          : {}),
        ...(input.setupDispatchUrl
          ? { setupDispatchUrl: input.setupDispatchUrl }
          : {}),
        ...(input.setupDispatchOutcomeUrl
          ? { setupDispatchOutcomeUrl: input.setupDispatchOutcomeUrl }
          : {}),
        ...(input.setupStatusUrl
          ? { setupStatusUrl: input.setupStatusUrl }
          : {}),
        ...(input.installerArguments
          ? { installerArguments: input.installerArguments }
          : {}),
      });
    },
    { timeout: setupTransactionTimeoutMs },
  );
}

export async function assertCodexRotatingSetupRecoveryWitness(
  tx: SetupManifestQueryClient,
  input: {
    readonly providerInstanceRowId: string;
    readonly configuredRecoveryWitness?: string;
    readonly forcedRecoveryAuthority: ForcedRecoveryAuthority | null;
  },
): Promise<string> {
  const currentFingerprint = fingerprintConfiguredSetupRecoveryWitness(
    input.configuredRecoveryWitness,
  );
  if (
    input.forcedRecoveryAuthority &&
    (input.forcedRecoveryAuthority.databaseRecoveryWitness !==
      currentFingerprint ||
      (input.forcedRecoveryAuthority.kind === "replay" &&
        input.forcedRecoveryAuthority.manifestDatabaseRecoveryWitness !==
          currentFingerprint))
  ) {
    throw new Error("codex_rotating_setup_recovery_required");
  }
  if (input.forcedRecoveryAuthority) {
    const recoveryOwnerId = `setup-recovery:${input.forcedRecoveryAuthority.requestId}`;
    const exactAuthority = await tx.$queryRaw<
      Array<{ readonly allowed: boolean }>
    >`
      SELECT EXISTS (
        SELECT 1
        FROM "CodexOAuthSetupRecoveryRequest" recovery
        JOIN "CodexOAuthProviderInstance" provider
          ON provider."id" = recovery."providerInstanceRowId"
        LEFT JOIN "CodexOAuthSetupManifest" manifest
          ON manifest."id" = recovery."latestManifestId"
        WHERE provider."id" = ${input.providerInstanceRowId}
          AND recovery."recoveryRequestId" = ${input.forcedRecoveryAuthority.requestId}
          AND recovery."mutationEpoch" = ${input.forcedRecoveryAuthority.epoch}
          AND recovery."databaseRecoveryWitness" = ${currentFingerprint}
          AND recovery."mode" IN ('forced_reseed', 'forced_reseed_account_switch')
          AND (
            (${input.forcedRecoveryAuthority.kind} = 'allocation'
              AND recovery."state" = 'active'
              AND recovery."latestManifestId" IS NULL
              AND provider."mutationEpoch" = recovery."mutationEpoch"
              AND provider."mutationOwner" = 'recovery'
              AND provider."mutationOwnerId" = ${recoveryOwnerId})
            OR
            (${input.forcedRecoveryAuthority.kind} = 'replay'
              AND recovery."state" = 'manifest_issued'
              AND manifest."providerInstanceRowId" = provider."id"
              AND manifest."status" = 'issued'
              AND manifest."mutationEpoch" = recovery."mutationEpoch" + 1
              AND manifest."mutationEpoch" = provider."mutationEpoch"
              AND manifest."databaseRecoveryWitness" = ${currentFingerprint}
              AND provider."mutationOwner" = 'setup'
              AND provider."mutationOwnerId" = manifest."id")
          )
      ) AS "allowed"
    `;
    if (exactAuthority[0]?.allowed !== true) {
      throw new Error("codex_rotating_setup_recovery_required");
    }
  }
  const evidence = await tx.$queryRaw<
    Array<{ readonly databaseRecoveryWitness: string | null }>
  >`
    SELECT evidence."databaseRecoveryWitness"
    FROM (
      SELECT manifest."databaseRecoveryWitness", manifest."mutationEpoch" AS "authorityEpoch",
             manifest."createdAt", 1 AS priority, manifest."id"
      FROM "CodexOAuthSetupManifest" manifest
      WHERE manifest."providerInstanceRowId" = ${input.providerInstanceRowId}
        AND manifest."mutationEpoch" IS NOT NULL
      UNION ALL
      SELECT claim."databaseRecoveryWitness", claim."recoveryEpoch" AS "authorityEpoch",
             claim."createdAt", 2 AS priority, claim."id"
      FROM "CodexOAuthSetupPayloadClaim" claim
      WHERE claim."providerInstanceRowId" = ${input.providerInstanceRowId}
      UNION ALL
      SELECT intent."databaseRecoveryWitness", intent."mutationEpoch" AS "authorityEpoch",
             intent."createdAt", 3 AS priority, intent."id"
      FROM "CodexOAuthWritebackIntent" intent
      WHERE intent."providerInstanceRowId" = ${input.providerInstanceRowId}
        AND intent."mutationEpoch" IS NOT NULL
      UNION ALL
      SELECT namespace."databaseRecoveryWitness",
             COALESCE(claim."recoveryEpoch", intent."mutationEpoch", 0::bigint) AS "authorityEpoch",
             namespace."createdAt", 4 AS priority, namespace."id"
      FROM "CodexOAuthSecretNamespace" namespace
      LEFT JOIN "CodexOAuthSetupDispatchAttempt" attempt
        ON attempt."namespaceId" = namespace."id"
      LEFT JOIN "CodexOAuthSetupPayloadClaim" claim
        ON claim."id" = attempt."claimId"
      LEFT JOIN "CodexOAuthWritebackIntent" intent
        ON intent."secretNamespaceId" = namespace."id"
      WHERE namespace."providerInstanceRowId" = ${input.providerInstanceRowId}
    ) evidence
    ORDER BY evidence."authorityEpoch" DESC, evidence.priority DESC,
             evidence."createdAt" DESC, evidence."id" DESC
    LIMIT 1
  `;
  if (input.forcedRecoveryAuthority?.kind === "allocation") {
    const liveAuthority = await tx.$queryRaw<Array<{ readonly count: bigint }>>`
      SELECT (
        (SELECT count(*) FROM "CodexOAuthSetupManifest"
         WHERE "providerInstanceRowId" = ${input.providerInstanceRowId}
           AND "status" IN ('issued', 'fetched'))
        +
        (SELECT count(*) FROM "CodexOAuthSetupPayloadClaim"
         WHERE "providerInstanceRowId" = ${input.providerInstanceRowId}
           AND "status" IN ('prepared', 'confirmed_candidate', 'active'))
        +
        (SELECT count(*) FROM "CodexOAuthSecretNamespace"
         WHERE "providerInstanceRowId" = ${input.providerInstanceRowId}
           AND "status" IN ('dispatch_authorized', 'confirmed_candidate', 'active'))
        +
        (SELECT count(*) FROM "CodexOAuthSetupDispatchAttempt" attempt
         JOIN "CodexOAuthSetupPayloadClaim" claim ON claim."id" = attempt."claimId"
         WHERE claim."providerInstanceRowId" = ${input.providerInstanceRowId}
           AND attempt."status" IN ('dispatch_authorized', 'confirmed'))
        +
        (SELECT count(*) FROM "CodexOAuthWritebackIntent"
         WHERE "providerInstanceRowId" = ${input.providerInstanceRowId}
           AND ("status" = 'pending'
             OR ("status" = 'remote_outcome_unknown' AND "recoveryResolvedAt" IS NULL)))
      )::bigint AS count
    `;
    if (liveAuthority[0]?.count !== 0n) {
      throw new Error("codex_rotating_setup_recovery_required");
    }
  }
  const persistedFingerprint = evidence[0]?.databaseRecoveryWitness;
  if (
    persistedFingerprint !== undefined &&
    persistedFingerprint !== currentFingerprint
  ) {
    if (input.forcedRecoveryAuthority?.kind !== "allocation") {
      throw new Error("codex_rotating_setup_recovery_required");
    }
  }
  return currentFingerprint;
}

function fingerprintConfiguredSetupRecoveryWitness(
  configuredRecoveryWitness: string | undefined,
): string {
  try {
    return fingerprintDatabaseRecoveryWitness(configuredRecoveryWitness ?? "");
  } catch {
    throw new Error("codex_rotating_setup_recovery_required");
  }
}

export async function transitionRecoveryRequestToManifestIssued(
  tx: SetupManifestTransaction,
  input: {
    readonly recoveryRequestRowId: string;
    readonly providerInstanceRowId: string;
    readonly recoveryRequestId: string;
    readonly recoveryEpoch: bigint;
    readonly databaseRecoveryWitness: string;
    readonly manifestId: string;
    readonly now: Date;
  },
): Promise<void> {
  const transitionedRecoveryRequest = await tx.$executeRaw`
    UPDATE "CodexOAuthSetupRecoveryRequest"
    SET "state" = 'manifest_issued', "latestManifestId" = ${input.manifestId},
        "updatedAt" = ${input.now}
    WHERE "id" = ${input.recoveryRequestRowId}
      AND "providerInstanceRowId" = ${input.providerInstanceRowId}
      AND "recoveryRequestId" = ${input.recoveryRequestId}
      AND "mutationEpoch" = ${input.recoveryEpoch}
      AND "databaseRecoveryWitness" = ${input.databaseRecoveryWitness}
      AND "state" = 'active'
      AND "latestManifestId" IS NULL
  `;
  if (transitionedRecoveryRequest !== 1) {
    throw new Error("codex_rotating_setup_recovery_transition_conflict");
  }
}

export async function resolveCodexRotatingSetupManifestForNonce(input: {
  readonly prisma: PrismaClient;
  readonly setupNonce: string;
  readonly databaseRecoveryWitness: string;
  readonly runtimeEnvironment?: NodeJS.ProcessEnv;
  readonly now?: Date;
}): Promise<{
  readonly manifestBase64: string;
  readonly expiresAt: string;
  readonly recoveryExpiresAt: string;
  readonly payloadClaimed: boolean;
  readonly recoveryEpoch: string;
}> {
  return input.prisma.$transaction(
    async (tx) => {
      // Resolve only the provider identity before entering the common lock
      // order. Taking the manifest row lock here would invert issuance and
      // recovery (provider -> manifest) and can deadlock with a concurrent
      // fetch (manifest -> provider).
      const initial = await findSetupManifestLocatorByNonce(
        tx,
        input.setupNonce,
      );
      await lockCodexRotatingSetupProvider(tx, initial.providerInstanceId);
      await lockCodexRotatingProviderRow(tx, initial.providerInstanceRowId);
      const now = input.now ?? new Date();
      const row = await findSetupManifestByNonce(tx, input.setupNonce);
      assertSetupManifestRecoveryWitness(
        row.databaseRecoveryWitness,
        input.databaseRecoveryWitness,
      );
      const manifest = codexRotatingSetupManifestSchema.parse(row.manifestJson);
      if (
        !isCodexRotatingOAuthAllowedForRepository(
          manifest.repositoryFullName,
          input.runtimeEnvironment,
        )
      ) {
        throw new Error("codex_rotating_not_enabled");
      }
      if (row.status === CodexRotatingSetupManifestStatus.Consumed) {
        if (
          !row.consumedAt ||
          (row.payloadClaimedAt === null &&
            !(await hasVersionedPayloadClaim(tx, row.id))) ||
          !row.recoveryExpiresAt ||
          row.recoveryExpiresAt <= now
        ) {
          throw new Error("codex_rotating_setup_manifest_expired");
        }
        return {
          manifestBase64: encodeCodexRotatingSetupManifest(manifest),
          expiresAt: manifest.expiresAt,
          recoveryExpiresAt: row.recoveryExpiresAt.toISOString(),
          payloadClaimed: true,
          recoveryEpoch: row.mutationEpoch!.toString(),
        };
      }
      if (!(await isCodexRotatingSetupFenceOwner(tx, row))) {
        throw new Error("codex_rotating_setup_confirmation_stale_epoch");
      }

      if (row.status === CodexRotatingSetupManifestStatus.Fetched) {
        assertFetchedRecoveryWindow(row, now);
        // Delivery is retryable for the bounded recovery window. The durable
        // payload claim, not the manifest bytes, fences any later PUT.
        return {
          manifestBase64: encodeCodexRotatingSetupManifest(manifest),
          expiresAt: manifest.expiresAt,
          recoveryExpiresAt: row.recoveryExpiresAt!.toISOString(),
          payloadClaimed:
            row.payloadClaimedAt !== null ||
            (await hasVersionedPayloadClaim(tx, row.id)),
          recoveryEpoch: row.mutationEpoch!.toString(),
        };
      }

      assertSetupManifestFetchable(row, now);
      const recoveryExpiresAt = new Date(
        now.getTime() + setupFetchedRecoveryWindowMs,
      );

      const updated = await tx.$executeRaw`
      UPDATE "CodexOAuthSetupManifest"
      SET "status" = ${CodexRotatingSetupManifestStatus.Fetched},
          "lastFetchedAt" = ${now}
          , "recoveryExpiresAt" = ${recoveryExpiresAt}
      WHERE "id" = ${row.id}
        AND "status" = ${CodexRotatingSetupManifestStatus.Issued}
        AND "consumedAt" IS NULL
        AND "expiresAt" > ${now}
    `;
      if (updated !== 1) {
        throw new Error("codex_rotating_setup_manifest_reused");
      }

      return {
        manifestBase64: encodeCodexRotatingSetupManifest(manifest),
        expiresAt: manifest.expiresAt,
        recoveryExpiresAt: recoveryExpiresAt.toISOString(),
        payloadClaimed: false,
        recoveryEpoch: row.mutationEpoch!.toString(),
      };
    },
    { timeout: setupTransactionTimeoutMs },
  );
}

export function assertSetupManifestRecoveryWitness(
  persistedFingerprint: string | null,
  configuredRecoveryWitness: string,
): void {
  let currentFingerprint: string;
  try {
    currentFingerprint = fingerprintDatabaseRecoveryWitness(
      configuredRecoveryWitness,
    );
  } catch {
    throw new Error("codex_rotating_setup_recovery_required");
  }
  if (persistedFingerprint !== currentFingerprint) {
    throw new Error("codex_rotating_setup_recovery_required");
  }
}

async function hasVersionedPayloadClaim(
  tx: SetupManifestTransaction,
  manifestId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "CodexOAuthSetupPayloadClaim"
      WHERE "manifestId" = ${manifestId}
        AND "status" IN ('prepared','confirmed_candidate','active')
    ) AS "exists"
  `;
  return rows[0]?.exists === true;
}

export function confirmCodexRotatingSetupManifest(input: {
  readonly prisma: PrismaClient;
  readonly payload: unknown;
  readonly now?: Date;
}): Promise<never> {
  void input;
  return Promise.reject(
    new Error("codex_rotating_legacy_stable_secret_removed"),
  );
}
async function findSetupManifestByNonce(
  prisma: Prisma.TransactionClient | PrismaClient,
  setupNonce: string,
): Promise<SetupManifestRow> {
  assertSetupNonce(setupNonce);
  const rows = await prisma.$queryRaw<SetupManifestRow[]>`
    SELECT
      "id",
      "providerInstanceRowId",
      "providerInstanceId",
      "repositoryId",
      "setupNonce",
      "manifestJson",
      "status",
      "expiresAt",
      "consumedAt",
      "confirmationJson",
      "mutationEpoch", "databaseRecoveryWitness", "recoveryExpiresAt", "payloadVersion",
      "payloadGenerationHash", "payloadAccountFingerprint", "payloadByteSize",
      "payloadClaimedAt"
    FROM "CodexOAuthSetupManifest"
    WHERE "setupNonce" = ${setupNonce}
    LIMIT 1 FOR UPDATE
  `;
  const row = rows[0];
  if (!row) {
    throw new Error("codex_rotating_setup_manifest_not_found");
  }
  return row;
}

async function findSetupManifestLocatorByNonce(
  prisma: Prisma.TransactionClient | PrismaClient,
  setupNonce: string,
): Promise<
  Pick<SetupManifestRow, "providerInstanceRowId" | "providerInstanceId">
> {
  assertSetupNonce(setupNonce);
  const rows = await prisma.$queryRaw<
    Array<
      Pick<SetupManifestRow, "providerInstanceRowId" | "providerInstanceId">
    >
  >`
    SELECT "providerInstanceRowId", "providerInstanceId"
    FROM "CodexOAuthSetupManifest"
    WHERE "setupNonce" = ${setupNonce}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    throw new Error("codex_rotating_setup_manifest_not_found");
  }
  return row;
}

function assertSetupNonce(setupNonce: string): void {
  if (!/^[A-Za-z0-9_.:-]{8,160}$/.test(setupNonce)) {
    throw new Error("codex_rotating_setup_manifest_not_found");
  }
}

type SetupRecoveryRequestRow = {
  readonly id: string;
  readonly mutationEpoch: bigint;
  readonly databaseRecoveryWitness: string | null;
  readonly mode: string;
  readonly state: string;
  readonly latestManifestId: string | null;
};

function isRecoveryRequestMode(mode: string): boolean {
  return mode === "forced_reseed" || mode === "forced_reseed_account_switch";
}

async function findSetupRecoveryRequest(
  tx: SetupManifestTransaction,
  providerInstanceRowId: string,
  recoveryRequestId: string,
): Promise<SetupRecoveryRequestRow | null> {
  const rows = await tx.$queryRaw<SetupRecoveryRequestRow[]>`
    SELECT "id", "mutationEpoch", "databaseRecoveryWitness", "mode", "state", "latestManifestId"
    FROM "CodexOAuthSetupRecoveryRequest"
    WHERE "providerInstanceRowId" = ${providerInstanceRowId}
      AND "recoveryRequestId" = ${recoveryRequestId}
    LIMIT 1 FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function findActiveSetupRecoveryRequest(
  tx: SetupManifestTransaction,
  providerInstanceRowId: string,
): Promise<{ readonly id: string } | null> {
  const rows = await tx.$queryRaw<Array<{ readonly id: string }>>`
    SELECT "id" FROM "CodexOAuthSetupRecoveryRequest"
    WHERE "providerInstanceRowId" = ${providerInstanceRowId}
      AND "state" IN ('active', 'manifest_issued')
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function assertSetupManifestFetchable(row: SetupManifestRow, now: Date): void {
  assertSetupManifestNotExpiredOrConsumed(row, now);
  if (row.status !== CodexRotatingSetupManifestStatus.Issued) {
    throw new Error("codex_rotating_setup_manifest_reused");
  }
}

function assertSetupManifestNotExpiredOrConsumed(
  row: SetupManifestRow,
  now: Date,
): void {
  if (
    row.status === CodexRotatingSetupManifestStatus.Consumed ||
    row.consumedAt
  ) {
    throw new Error("codex_rotating_setup_manifest_reused");
  }
  if (
    row.status === CodexRotatingSetupManifestStatus.Expired ||
    row.expiresAt <= now
  ) {
    throw new Error("codex_rotating_setup_manifest_expired");
  }
}

function assertFetchedRecoveryWindow(row: SetupManifestRow, now: Date): void {
  if (
    row.status !== CodexRotatingSetupManifestStatus.Fetched ||
    row.consumedAt ||
    !row.recoveryExpiresAt ||
    row.recoveryExpiresAt <= now
  ) {
    throw new Error("codex_rotating_setup_manifest_expired");
  }
}

async function expireActiveSetupManifests(
  prisma: SetupManifestTransaction,
  providerInstanceRowId: string,
  now: Date,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "CodexOAuthSetupManifest"
    SET "status" = ${CodexRotatingSetupManifestStatus.Expired}
    WHERE "providerInstanceRowId" = ${providerInstanceRowId}
      AND "status" = ${CodexRotatingSetupManifestStatus.Issued}
      AND "expiresAt" <= ${now}
  `;
}

async function findActiveSetupManifestForProvider(
  prisma: SetupManifestTransaction,
  providerInstanceRowId: string,
): Promise<SetupManifestRow | null> {
  const rows = await prisma.$queryRaw<SetupManifestRow[]>`
    SELECT
      "id",
      "providerInstanceRowId",
      "providerInstanceId",
      "repositoryId",
      "setupNonce",
      "manifestJson",
      "status",
      "expiresAt",
      "consumedAt",
      "confirmationJson",
      "mutationEpoch", "databaseRecoveryWitness", "recoveryExpiresAt", "payloadVersion",
      "payloadGenerationHash", "payloadAccountFingerprint", "payloadByteSize",
      "payloadClaimedAt"
    FROM "CodexOAuthSetupManifest"
    WHERE "providerInstanceRowId" = ${providerInstanceRowId}
      AND "status" IN (
        ${CodexRotatingSetupManifestStatus.Issued},
        ${CodexRotatingSetupManifestStatus.Fetched}
      )
    ORDER BY "createdAt" DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function supersedeSetupManifest(
  prisma: SetupManifestTransaction,
  id: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "CodexOAuthSetupManifest"
    SET "status" = ${CodexRotatingSetupManifestStatus.Superseded}
    WHERE "id" = ${id}
      AND "status" = ${CodexRotatingSetupManifestStatus.Issued}
  `;
}

function isReusableIssuedManifest(input: {
  readonly manifest: ReturnType<typeof codexRotatingSetupManifestSchema.parse>;
  readonly provider: {
    readonly generationHashSalt: string;
    readonly accountFingerprintSalt: string;
  };
  readonly repositoryFullName: string;
  readonly githubRepositoryId: string;
  readonly installer: CodexRotatingSeedScriptDescriptor;
}): boolean {
  return (
    input.manifest.repositoryFullName === input.repositoryFullName &&
    input.manifest.repositoryId === input.githubRepositoryId &&
    input.manifest.generationHashSalt === input.provider.generationHashSalt &&
    input.manifest.accountFingerprintSalt ===
      input.provider.accountFingerprintSalt &&
    input.manifest.installer.url === input.installer.url &&
    input.manifest.installer.version === input.installer.version &&
    input.manifest.installer.sha256 === input.installer.sha256
  );
}

function setupCommandResult(input: {
  readonly manifest: ReturnType<typeof codexRotatingSetupManifestSchema.parse>;
  readonly setupManifestUrl: string;
  readonly setupPrepareUrl?: string;
  readonly setupDispatchUrl?: string;
  readonly setupDispatchOutcomeUrl?: string;
  readonly setupStatusUrl?: string;
  readonly installerArguments?: readonly CodexRotatingInstallerArgument[];
}) {
  return {
    command: renderCodexRotatingInstallerCommand({
      manifest: input.manifest,
      setupManifestUrl: input.setupManifestUrl,
      ...(input.setupPrepareUrl
        ? { setupPrepareUrl: input.setupPrepareUrl }
        : {}),
      ...(input.setupDispatchUrl
        ? { setupDispatchUrl: input.setupDispatchUrl }
        : {}),
      ...(input.setupDispatchOutcomeUrl
        ? { setupDispatchOutcomeUrl: input.setupDispatchOutcomeUrl }
        : {}),
      ...(input.setupStatusUrl ? { setupStatusUrl: input.setupStatusUrl } : {}),
      ...(input.installerArguments
        ? { installerArguments: input.installerArguments }
        : {}),
    }),
    expiresAt: input.manifest.expiresAt,
    providerInstanceId: input.manifest.providerInstanceId,
  } as const;
}
