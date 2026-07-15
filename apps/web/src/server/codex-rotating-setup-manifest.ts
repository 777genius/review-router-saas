import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  buildCodexRotatingSetupManifest,
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

const setupManifestTtlSeconds = 15 * 60;

const setupConfirmationSchema = z
  .object({
    protocolVersion: z.literal(1),
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

type SetupManifestRow = {
  readonly id: string;
  readonly providerInstanceRowId: string;
  readonly providerInstanceId: string;
  readonly repositoryId: string;
  readonly setupNonce: string;
  readonly manifestJson: unknown;
  readonly status: "issued" | "fetched" | "consumed";
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
};

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
  const now = input.now ?? new Date();
  const providerInstanceId = `codex-rotating:${input.githubRepositoryId}`;
  const setupNonce = `stp:${randomUUID()}`;

  const provider = await input.prisma.codexOAuthProviderInstance.upsert({
    where: { providerInstanceId },
    update: {
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      authMode: codexRotatingAuthMode,
      secretName: codexRotatingSecretName,
    },
    create: {
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      providerInstanceId,
      authMode: codexRotatingAuthMode,
      secretName: codexRotatingSecretName,
      generationHashSalt: createCodexRotatingSalt(),
      accountFingerprintSalt: createCodexRotatingSalt(),
    },
    select: {
      id: true,
      generationHashSalt: true,
      accountFingerprintSalt: true,
    },
  });

  const manifest = buildCodexRotatingSetupManifest({
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

  await input.prisma.$executeRaw`
    INSERT INTO "CodexOAuthSetupManifest" (
      "id",
      "workspaceId",
      "repositoryId",
      "providerInstanceRowId",
      "providerInstanceId",
      "setupNonce",
      "manifestJson",
      "status",
      "expiresAt"
    )
    VALUES (
      ${`codex_setup_${randomUUID()}`},
      ${input.workspaceId},
      ${input.repositoryId},
      ${provider.id},
      ${providerInstanceId},
      ${setupNonce},
      CAST(${JSON.stringify(manifest)} AS jsonb),
      'issued',
      ${new Date(manifest.expiresAt)}
    )
  `;

  return {
    command: renderCodexRotatingInstallerCommand({
      manifest,
      setupManifestUrl: input.setupManifestUrl,
      setupConfirmUrl: input.setupConfirmUrl,
      ...(input.installerArguments
        ? { installerArguments: input.installerArguments }
        : {}),
    }),
    expiresAt: manifest.expiresAt,
    providerInstanceId,
    secretName: codexRotatingSecretName,
  };
}

export async function resolveCodexRotatingSetupManifestForNonce(input: {
  readonly prisma: PrismaClient;
  readonly setupNonce: string;
  readonly now?: Date;
}): Promise<{ readonly manifestBase64: string; readonly expiresAt: string }> {
  const now = input.now ?? new Date();
  return input.prisma.$transaction(async (tx) => {
    const row = await findSetupManifestByNonce(tx, input.setupNonce);
    assertSetupManifestFetchable(row, now);
    const manifest = codexRotatingSetupManifestSchema.parse(row.manifestJson);
    if (
      !isCodexRotatingOAuthAllowedForRepository(manifest.repositoryFullName)
    ) {
      throw new Error("codex_rotating_not_enabled");
    }

    const updated = await tx.$executeRaw`
      UPDATE "CodexOAuthSetupManifest"
      SET "status" = 'fetched', "lastFetchedAt" = ${now}
      WHERE "id" = ${row.id}
        AND "status" = 'issued'
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
  });
}

export async function confirmCodexRotatingSetupManifest(input: {
  readonly prisma: PrismaClient;
  readonly payload: unknown;
  readonly now?: Date;
}): Promise<{ readonly status: "accepted" }> {
  const payload = setupConfirmationSchema.parse(input.payload);
  const now = input.now ?? new Date();

  await input.prisma.$transaction(async (tx) => {
    const row = await findSetupManifestByNonce(tx, payload.setupNonce);
    assertSetupManifestConfirmable(row, now);
    const manifest = codexRotatingSetupManifestSchema.parse(row.manifestJson);
    if (
      !isCodexRotatingOAuthAllowedForRepository(manifest.repositoryFullName)
    ) {
      throw new Error("codex_rotating_not_enabled");
    }
    if (
      manifest.repositoryId !== payload.repositoryId ||
      manifest.providerInstanceId !== payload.providerInstanceId ||
      manifest.secretName !== payload.secretName ||
      manifest.installer.version !== payload.installerVersion
    ) {
      throw new Error("codex_rotating_setup_confirmation_mismatch");
    }

    const provider = await tx.codexOAuthProviderInstance.findUnique({
      where: { providerInstanceId: payload.providerInstanceId },
      select: {
        id: true,
        latestGeneration: true,
        latestGenerationHash: true,
        generationHashSalt: true,
        accountFingerprintSalt: true,
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

    await tx.codexOAuthProviderInstance.update({
      where: { id: provider.id },
      data: {
        latestGeneration: provider.latestGenerationHash
          ? provider.latestGeneration + 1
          : provider.latestGeneration,
        latestGenerationHash: payload.generationHash,
        state: "active",
        activeLeaseId: null,
        activeLeaseExpiresAt: null,
      },
    });
    const updated = await tx.$executeRaw`
      UPDATE "CodexOAuthSetupManifest"
      SET "status" = 'consumed', "consumedAt" = ${now}
      WHERE "id" = ${row.id} AND "consumedAt" IS NULL
    `;
    if (updated !== 1) {
      throw new Error("codex_rotating_setup_manifest_reused");
    }
  });

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
      "consumedAt"
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
  if (row.status !== "issued") {
    throw new Error("codex_rotating_setup_manifest_reused");
  }
  assertSetupManifestNotExpiredOrConsumed(row, now);
}

function assertSetupManifestConfirmable(
  row: SetupManifestRow,
  now: Date,
): void {
  if (row.status !== "fetched") {
    throw new Error("codex_rotating_setup_manifest_reused");
  }
  assertSetupManifestNotExpiredOrConsumed(row, now);
}

function assertSetupManifestNotExpiredOrConsumed(
  row: SetupManifestRow,
  now: Date,
): void {
  if (row.status === "consumed" || row.consumedAt) {
    throw new Error("codex_rotating_setup_manifest_reused");
  }
  if (row.expiresAt <= now) {
    throw new Error("codex_rotating_setup_manifest_expired");
  }
}
