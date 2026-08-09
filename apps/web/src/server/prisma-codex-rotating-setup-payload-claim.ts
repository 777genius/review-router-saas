import { Prisma, type PrismaClient } from "@prisma/client";
import {
  codexRotatingSetupManifestSchema,
  codexRotatingSetupPayloadClaimsMatch,
  type CodexRotatingSetupPayloadClaim,
  type CodexRotatingSetupPayloadClaimPort,
} from "@reviewrouter/features-provider-setup";
import { isCodexRotatingOAuthAllowedForRepository } from "@reviewrouter/platform-config";
import {
  isCodexRotatingSetupFenceOwner,
  lockCodexRotatingProviderRow,
  lockCodexRotatingSetupProvider,
} from "./codex-rotating-provider-mutation-fence";

const transactionTimeoutMs = 10_000;

type ClaimRow = {
  readonly id: string;
  readonly providerInstanceRowId: string;
  readonly providerInstanceId: string;
  readonly repositoryId: string;
  readonly setupNonce: string;
  readonly manifestJson: unknown;
  readonly status: string;
  readonly mutationEpoch: bigint | null;
  readonly recoveryExpiresAt: Date | null;
  readonly payloadVersion: number | null;
  readonly payloadGenerationHash: string | null;
  readonly payloadAccountFingerprint: string | null;
  readonly payloadByteSize: number | null;
  readonly payloadClaimedAt: Date | null;
};

export class PrismaCodexRotatingSetupPayloadClaim implements CodexRotatingSetupPayloadClaimPort {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(claim: CodexRotatingSetupPayloadClaim) {
    return this.prisma.$transaction(
      async (tx) => {
        const initial = await findByNonce(tx, claim.setupNonce);
        await lockCodexRotatingSetupProvider(tx, initial.providerInstanceId);
        await lockCodexRotatingProviderRow(tx, initial.providerInstanceRowId);
        const row = await findByNonce(tx, claim.setupNonce);
        const manifest = codexRotatingSetupManifestSchema.parse(
          row.manifestJson,
        );

        if (
          manifest.repositoryId !== claim.repositoryId ||
          manifest.providerInstanceId !== claim.providerInstanceId ||
          manifest.installer.version !== claim.installerVersion ||
          !isCodexRotatingOAuthAllowedForRepository(manifest.repositoryFullName)
        ) {
          throw new Error("codex_rotating_setup_payload_claim_mismatch");
        }
        if (
          row.status !== "consumed" &&
          !(await isCodexRotatingSetupFenceOwner(tx, row))
        ) {
          throw new Error("codex_rotating_setup_confirmation_stale_epoch");
        }
        const now = new Date();
        if (
          !["fetched", "consumed"].includes(row.status) ||
          !row.recoveryExpiresAt ||
          row.recoveryExpiresAt <= now
        ) {
          throw new Error("codex_rotating_setup_payload_claim_expired");
        }

        if (row.payloadClaimedAt !== null) {
          const stored: CodexRotatingSetupPayloadClaim = {
            payloadVersion: 1,
            repositoryId: manifest.repositoryId!,
            providerInstanceId: row.providerInstanceId,
            setupNonce: row.setupNonce,
            generationHash: row.payloadGenerationHash!,
            accountFingerprint: row.payloadAccountFingerprint!,
            authByteSize: row.payloadByteSize!,
            installerVersion: manifest.installer.version,
          };
          if (!codexRotatingSetupPayloadClaimsMatch(stored, claim)) {
            throw new Error("codex_rotating_setup_payload_claim_conflict");
          }
          // A consumed manifest proves that a client already observed a
          // successful PUT and confirmed it. Never redispatch that old payload:
          // the provider may have advanced to a later generation meanwhile.
          return {
            status:
              row.status === "consumed"
                ? ("already_confirmed" as const)
                : ("already_claimed" as const),
          };
        }

        const updated = await tx.$executeRaw`
          UPDATE "CodexOAuthSetupManifest"
          SET "payloadVersion" = ${claim.payloadVersion},
              "payloadGenerationHash" = ${claim.generationHash},
              "payloadAccountFingerprint" = ${claim.accountFingerprint},
              "payloadByteSize" = ${claim.authByteSize},
              "payloadClaimedAt" = ${now}
          WHERE "id" = ${row.id}
            AND "payloadClaimedAt" IS NULL
            AND "status" IN ('fetched', 'consumed')
            AND "recoveryExpiresAt" > ${now}
        `;
        if (updated !== 1) {
          throw new Error("codex_rotating_setup_payload_claim_conflict");
        }
        return { status: "claimed" as const };
      },
      { timeout: transactionTimeoutMs },
    );
  }
}

async function findByNonce(
  tx: Prisma.TransactionClient,
  setupNonce: string,
): Promise<ClaimRow> {
  const rows = await tx.$queryRaw<ClaimRow[]>`
    SELECT "id", "providerInstanceRowId", "providerInstanceId", "repositoryId",
           "setupNonce", "manifestJson", "status", "mutationEpoch",
           "recoveryExpiresAt", "payloadVersion", "payloadGenerationHash",
           "payloadAccountFingerprint", "payloadByteSize", "payloadClaimedAt"
    FROM "CodexOAuthSetupManifest"
    WHERE "setupNonce" = ${setupNonce}
    LIMIT 1
  `;
  if (!rows[0]) throw new Error("codex_rotating_setup_manifest_not_found");
  return rows[0];
}
