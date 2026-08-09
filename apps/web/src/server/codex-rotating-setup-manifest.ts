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
  renderCodexRotatingInstallerCommand,
  type CodexRotatingInstallerArgument,
} from "@reviewrouter/features-provider-setup";
import { isCodexRotatingOAuthAllowedForRepository } from "@reviewrouter/platform-config";
import { z } from "zod";
import type { CodexRotatingSeedScriptDescriptor } from "./codex-rotating-seed-script";
import {
  isCodexRotatingSetupFenceOwner,
  lockCodexRotatingProviderRow,
  pinCodexRotatingSetupRecovery,
  supersedeFetchedSetupForRecovery,
} from "./codex-rotating-provider-mutation-fence";

const setupManifestTtlSeconds = 15 * 60;
const setupLockRetryIntervalMs = 100;
const setupLockMaxAttempts = 50;
const setupTransactionTimeoutMs = 10_000;

function assertSetupIssuanceEnabled(): void {
  if (process.env.REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED === "0") {
    throw new Error("codex_rotating_setup_issuance_quiesced");
  }
}

export enum CodexRotatingSetupManifestStatus {
  Issued = "issued",
  Fetched = "fetched",
  Consumed = "consumed",
  Expired = "expired",
  Superseded = "superseded",
}

const setupConfirmationSchema = z
  .object({
    protocolVersion: z.union([z.literal(1), z.literal(2)]),
    repositoryId: z.string().regex(/^[0-9]+$/),
    providerInstanceId: z.string().regex(/^[A-Za-z0-9_.:-]{8,160}$/),
    setupNonce: z.string().regex(/^[A-Za-z0-9_.:-]{8,160}$/),
    secretName: z.literal(codexRotatingSecretName),
    generationHash: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    accountFingerprint: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    authByteSizeBucket: z.enum(["0-4KiB", "4-8KiB", "8-16KiB", "16-32KiB"]),
    installerVersion: z.string().min(1).max(120),
  })
  .strict();

type SetupConfirmation = z.infer<typeof setupConfirmationSchema>;

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
};

type SetupManifestTransaction = Prisma.TransactionClient;

export async function issueCodexRotatingSetupCommand(input: {
  readonly prisma: PrismaClient;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly githubRepositoryId: string;
  readonly installer: CodexRotatingSeedScriptDescriptor;
  readonly setupManifestUrl: string;
  readonly setupConfirmUrl: string;
  readonly installerArguments?: readonly CodexRotatingInstallerArgument[];
  readonly now?: Date;
}): Promise<{
  readonly command: string;
  readonly expiresAt: string;
  readonly providerInstanceId: string;
  readonly secretName: typeof codexRotatingSecretName;
}> {
  assertSetupIssuanceEnabled();
  const providerInstanceId = canonicalCodexRotatingProviderId(
    input.githubRepositoryId,
  );
  return input.prisma.$transaction(
    async (tx) => {
      await lockSetupProvider(tx, providerInstanceId);
      let provider = await tx.codexOAuthProviderInstance.findUnique({
        where: {
          repositoryId_authMode: {
            repositoryId: input.repositoryId,
            authMode: codexRotatingAuthMode,
          },
        },
      });
      if (!provider) {
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
      await lockCodexRotatingProviderRow(tx, provider.id);
      provider = await tx.codexOAuthProviderInstance.findUniqueOrThrow({
        where: { id: provider.id },
      });
      const now = input.now ?? new Date();
      await expireActiveSetupManifests(tx, provider.id, now);

      const active = await findActiveSetupManifestForProvider(tx, provider.id);
      const parsedActive = active
        ? codexRotatingSetupManifestSchema.safeParse(active.manifestJson)
        : null;
      if (active?.status === CodexRotatingSetupManifestStatus.Fetched) {
        if (provider.mutationOwner !== "recovery") {
          throw new Error("codex_rotating_setup_in_progress");
        }
        await supersedeFetchedSetupForRecovery(tx, active.id);
      }
      const pendingIntent = await tx.codexOAuthWritebackIntent.findFirst({
        where: { providerInstanceRowId: provider.id, status: "pending" },
        select: { id: true },
      });
      if (
        pendingIntent ||
        (provider.mutationOwner === "runtime" &&
          provider.activeLeaseExpiresAt &&
          provider.activeLeaseExpiresAt > now)
      ) {
        throw new Error("codex_rotating_mutation_fence_conflict");
      }

      let manifest = parsedActive?.success ? parsedActive.data : null;
      if (
        active &&
        (!manifest ||
          active.mutationEpoch === null ||
          active.mutationEpoch !== provider.mutationEpoch ||
          provider.mutationOwner !== "setup" ||
          provider.mutationOwnerId !== active.id ||
          !isReusableIssuedManifest({
            manifest,
            provider,
            repositoryFullName: input.repositoryFullName,
            githubRepositoryId: input.githubRepositoryId,
            installer: input.installer,
          }))
      ) {
        await supersedeSetupManifest(tx, active.id);
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
          "mutationEpoch"
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
          ${mutationEpoch}
        )
      `;
      }

      return setupCommandResult({
        manifest,
        setupManifestUrl: input.setupManifestUrl,
        setupConfirmUrl: input.setupConfirmUrl,
        ...(input.installerArguments
          ? { installerArguments: input.installerArguments }
          : {}),
      });
    },
    { timeout: setupTransactionTimeoutMs },
  );
}

export async function resolveCodexRotatingSetupManifestForNonce(input: {
  readonly prisma: PrismaClient;
  readonly setupNonce: string;
  readonly now?: Date;
}): Promise<{ readonly manifestBase64: string; readonly expiresAt: string }> {
  return input.prisma.$transaction(
    async (tx) => {
      const initial = await findSetupManifestByNonce(tx, input.setupNonce);
      await lockSetupProvider(tx, initial.providerInstanceId);
      await lockCodexRotatingProviderRow(tx, initial.providerInstanceRowId);
      const now = input.now ?? new Date();
      const row = await findSetupManifestByNonce(tx, input.setupNonce);
      assertSetupManifestFetchable(row, now);
      const manifest = codexRotatingSetupManifestSchema.parse(row.manifestJson);
      if (
        !isCodexRotatingOAuthAllowedForRepository(manifest.repositoryFullName)
      ) {
        throw new Error("codex_rotating_not_enabled");
      }
      if (!(await isCodexRotatingSetupFenceOwner(tx, row))) {
        throw new Error("codex_rotating_setup_confirmation_stale_epoch");
      }

      const updated = await tx.$executeRaw`
      UPDATE "CodexOAuthSetupManifest"
      SET "status" = ${CodexRotatingSetupManifestStatus.Fetched},
          "lastFetchedAt" = ${now}
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
      };
    },
    { timeout: setupTransactionTimeoutMs },
  );
}

export async function confirmCodexRotatingSetupManifest(input: {
  readonly prisma: PrismaClient;
  readonly payload: unknown;
  readonly now?: Date;
}): Promise<{ readonly status: "accepted" }> {
  const payload = setupConfirmationSchema.parse(input.payload);

  const confirmation = await input.prisma.$transaction(
    async (tx) => {
      const initial = await findSetupManifestByNonce(tx, payload.setupNonce);
      await lockSetupProvider(tx, initial.providerInstanceId);
      await lockCodexRotatingProviderRow(tx, initial.providerInstanceRowId);
      const now = input.now ?? new Date();
      const row = await findSetupManifestByNonce(tx, payload.setupNonce);
      const manifest = codexRotatingSetupManifestSchema.parse(row.manifestJson);
      if (
        manifest.repositoryId !== payload.repositoryId ||
        manifest.providerInstanceId !== payload.providerInstanceId ||
        manifest.secretName !== payload.secretName ||
        manifest.installer.version !== payload.installerVersion
      ) {
        throw new Error("codex_rotating_setup_confirmation_mismatch");
      }
      if (row.status === CodexRotatingSetupManifestStatus.Consumed) {
        const stored = setupConfirmationSchema.safeParse(row.confirmationJson);
        if (stored.success && setupConfirmationsMatch(stored.data, payload)) {
          return "accepted" as const;
        }
        throw new Error("codex_rotating_setup_confirmation_mismatch");
      }
      if (
        !isCodexRotatingOAuthAllowedForRepository(manifest.repositoryFullName)
      ) {
        throw new Error("codex_rotating_not_enabled");
      }
      assertSetupManifestConfirmable(row);
      if (!(await isCodexRotatingSetupFenceOwner(tx, row))) {
        await pinCodexRotatingSetupRecovery(
          tx,
          row.providerInstanceRowId,
          row.id,
        );
        return "stale" as const;
      }

      const provider = await tx.codexOAuthProviderInstance.findUnique({
        where: { providerInstanceId: payload.providerInstanceId },
        select: {
          id: true,
          latestGeneration: true,
          latestGenerationHash: true,
          generationHashSalt: true,
          accountFingerprintSalt: true,
          mutationEpoch: true,
          mutationOwner: true,
          mutationOwnerId: true,
        },
      });
      if (
        !provider ||
        provider.id !== row.providerInstanceRowId ||
        provider.generationHashSalt !== manifest.generationHashSalt ||
        provider.accountFingerprintSalt !== manifest.accountFingerprintSalt
      ) {
        throw new Error("codex_rotating_setup_salt_mismatch");
      }

      const confirmed = await tx.codexOAuthProviderInstance.updateMany({
        where: {
          id: provider.id,
          mutationEpoch: row.mutationEpoch!,
          mutationOwner: "setup",
          mutationOwnerId: row.id,
        },
        data: {
          latestGeneration: provider.latestGenerationHash
            ? provider.latestGeneration + 1
            : provider.latestGeneration,
          latestGenerationHash: payload.generationHash,
          state: "active",
          activeLeaseId: null,
          activeLeaseExpiresAt: null,
          mutationOwner: null,
          mutationOwnerId: null,
        },
      });
      if (confirmed.count !== 1) {
        await pinCodexRotatingSetupRecovery(tx, provider.id, row.id);
        return "stale" as const;
      }
      const updated = await tx.$executeRaw`
      UPDATE "CodexOAuthSetupManifest"
      SET "status" = ${CodexRotatingSetupManifestStatus.Consumed},
          "consumedAt" = ${now},
          "confirmationJson" = CAST(${JSON.stringify(payload)} AS jsonb)
      WHERE "id" = ${row.id}
        AND "status" = ${CodexRotatingSetupManifestStatus.Fetched}
        AND "consumedAt" IS NULL
    `;
      if (updated !== 1) {
        throw new Error("codex_rotating_setup_manifest_reused");
      }
      return "accepted" as const;
    },
    { timeout: setupTransactionTimeoutMs },
  );

  if (confirmation === "stale") {
    throw new Error("codex_rotating_setup_confirmation_stale_epoch");
  }

  return { status: "accepted" };
}

async function findSetupManifestByNonce(
  prisma: Prisma.TransactionClient | PrismaClient,
  setupNonce: string,
): Promise<SetupManifestRow> {
  if (!/^[A-Za-z0-9_.:-]{8,160}$/.test(setupNonce)) {
    throw new Error("codex_rotating_setup_manifest_not_found");
  }
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
      "mutationEpoch"
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

function assertSetupManifestFetchable(row: SetupManifestRow, now: Date): void {
  assertSetupManifestNotExpiredOrConsumed(row, now);
  if (row.status !== CodexRotatingSetupManifestStatus.Issued) {
    throw new Error("codex_rotating_setup_manifest_reused");
  }
}

function assertSetupManifestConfirmable(row: SetupManifestRow): void {
  if (
    row.status === CodexRotatingSetupManifestStatus.Consumed ||
    row.consumedAt
  ) {
    throw new Error("codex_rotating_setup_manifest_reused");
  }
  if (row.status !== CodexRotatingSetupManifestStatus.Fetched) {
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

async function lockSetupProvider(
  prisma: SetupManifestTransaction,
  providerInstanceId: string,
): Promise<void> {
  for (let attempt = 1; attempt <= setupLockMaxAttempts; attempt += 1) {
    const rows = await prisma.$queryRaw<
      Array<{ readonly acquired: boolean }>
    >(Prisma.sql`
      SELECT pg_try_advisory_xact_lock(
        hashtextextended(${`codex-rotating-setup:${providerInstanceId}`}, 0)
      ) AS "acquired"
    `);
    if (rows[0]?.acquired === true) return;
    if (attempt < setupLockMaxAttempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, setupLockRetryIntervalMs),
      );
    }
  }
  throw new Error("codex_rotating_setup_lock_failed");
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
      "mutationEpoch"
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
  readonly setupConfirmUrl: string;
  readonly installerArguments?: readonly CodexRotatingInstallerArgument[];
}) {
  return {
    command: renderCodexRotatingInstallerCommand({
      manifest: input.manifest,
      setupManifestUrl: input.setupManifestUrl,
      setupConfirmUrl: input.setupConfirmUrl,
      ...(input.installerArguments
        ? { installerArguments: input.installerArguments }
        : {}),
    }),
    expiresAt: input.manifest.expiresAt,
    providerInstanceId: input.manifest.providerInstanceId,
    secretName: codexRotatingSecretName,
  } as const;
}

function setupConfirmationsMatch(
  left: SetupConfirmation,
  right: SetupConfirmation,
): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.repositoryId === right.repositoryId &&
    left.providerInstanceId === right.providerInstanceId &&
    left.setupNonce === right.setupNonce &&
    left.secretName === right.secretName &&
    left.generationHash === right.generationHash &&
    left.accountFingerprint === right.accountFingerprint &&
    left.authByteSizeBucket === right.authByteSizeBucket &&
    left.installerVersion === right.installerVersion
  );
}
