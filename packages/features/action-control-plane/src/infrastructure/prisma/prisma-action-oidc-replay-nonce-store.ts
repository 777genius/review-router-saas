import type { PrismaClient } from "@prisma/client";
import type {
  ActionOidcReplayNonceCleanupPort,
  ActionOidcReplayNonceStorePort,
  ConsumeActionOidcReplayNonceInput,
  DeleteExpiredActionOidcReplayNoncesInput,
  DeleteExpiredActionOidcReplayNoncesResult,
} from "../../application/ports/action-oidc-replay-nonce-store-port.js";

type ConsumedNonceRow = {
  readonly key: string;
};

export class PrismaActionOidcReplayNonceStore
  implements ActionOidcReplayNonceStorePort, ActionOidcReplayNonceCleanupPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async tryConsumeNonce(
    input: ConsumeActionOidcReplayNonceInput,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<ConsumedNonceRow[]>`
      INSERT INTO "ActionOidcReplayNonce" (
        "key",
        "expiresAt",
        "createdAt"
      )
      VALUES (
        ${input.key},
        ${input.expiresAt},
        ${input.now}
      )
      ON CONFLICT ("key") DO NOTHING
      RETURNING "key"
    `;

    return rows.length === 1;
  }

  async deleteExpiredNonces(
    input: DeleteExpiredActionOidcReplayNoncesInput,
  ): Promise<DeleteExpiredActionOidcReplayNoncesResult> {
    const rows = await this.prisma.$queryRaw<ConsumedNonceRow[]>`
      WITH expired AS (
        SELECT "key"
        FROM "ActionOidcReplayNonce"
        WHERE "expiresAt" <= ${input.expiredBefore}
        ORDER BY "expiresAt" ASC
        LIMIT ${input.limit}
      )
      DELETE FROM "ActionOidcReplayNonce"
      USING expired
      WHERE "ActionOidcReplayNonce"."key" = expired."key"
      RETURNING "ActionOidcReplayNonce"."key"
    `;

    return { deleted: rows.length };
  }
}
