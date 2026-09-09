import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { VerifiedReviewRunAuthorizationTokenWithMetadata } from "../../application/ports/platform-ports";
import { tokenClaimsMatchAuthorization } from "../../application/use-cases/token-claims-match-authorization";
import type { ReviewRunAuthorization } from "../../domain/review-run-authorization";
import {
  canonicalJson,
  ReviewRunAuthorizationState,
} from "../../domain/review-run-control-types";
import { ReviewRunAuthorizationSignedCapabilityAdapter } from "../signed-capabilities/review-run-authorization-token-adapter";
import { reviewRunAuthorizationToDomain } from "./prisma-review-run-control-mappers";
import {
  lockReviewRunControlKeys,
  type ReviewRunControlTransaction,
} from "./prisma-review-run-control-utils";

const verifiedPrincipalBrand: unique symbol = Symbol("verified_run_principal");
type TokenMetadata = Readonly<
  Omit<
    VerifiedReviewRunAuthorizationTokenWithMetadata,
    "issuedAt" | "expiresAt" | "notBefore"
  > & {
    readonly issuedAtMs: number;
    readonly expiresAtMs: number;
    readonly notBeforeMs: number;
  }
>;

/** Request-local verified evidence, never a transport DTO or a retained credential. */
export type VerifiedCurrentReviewRunPrincipal = Readonly<{
  readonly [verifiedPrincipalBrand]: true;
  readonly token: TokenMetadata;
  readonly verifiedAtMs: number;
  readonly tokenSha256: string;
}>;

type AuthorizationSnapshot = Readonly<
  Omit<
    ReviewRunAuthorization,
    "createdAt" | "renewedAt" | "expiresAt" | "maxExpiresAt"
  > & {
    readonly createdAtMs: number;
    readonly renewedAtMs: number | null;
    readonly expiresAtMs: number;
    readonly maxExpiresAtMs: number;
    readonly revokedAtMs: number | null;
  }
>;

export type LockedCurrentReviewRunPrincipal = Readonly<{
  readonly principal: VerifiedCurrentReviewRunPrincipal;
  readonly authorization: AuthorizationSnapshot;
  /** Sample DB time AFTER all subsequent waits, immediately before synchronous work.
   * Recovery calls this too, even when it has no fork lease. Valid only while the
   * caller's transaction holds these locks; close in that transaction's finally.
   */
  assert(at: number): void;
  close(): void;
}>;

/** Only the run principal component. This does not authorize installation,
 * configuration, safety, provider, release, ownership, or Fork command admission.
 * Acquire scope guards BEFORE this reader, and Family/other downstream locks
 * AFTER it. Never invoke a writer/root client while holding this reader's locks.
 */
export class PrismaLockedReviewRunPrincipalReader {
  readonly #verified = new WeakSet<VerifiedCurrentReviewRunPrincipal>();

  constructor(
    private readonly tokens: ReviewRunAuthorizationSignedCapabilityAdapter,
  ) {}

  async preflight(bearer: string): Promise<VerifiedCurrentReviewRunPrincipal> {
    const now = new Date();
    // Actual r112 authenticated kid/nbf seam; JOSE's configured skew stays here.
    const verified = await this.tokens.verifyWithMetadata({
      token: bearer,
      now,
    });
    const { issuedAt, expiresAt, notBefore, ...claims } = verified;
    const principal: VerifiedCurrentReviewRunPrincipal = Object.freeze({
      [verifiedPrincipalBrand]: true as const,
      token: Object.freeze({
        ...claims,
        providerVoteLaneIds: Object.freeze([...claims.providerVoteLaneIds]),
        issuedAtMs: issuedAt.getTime(),
        expiresAtMs: expiresAt.getTime(),
        notBeforeMs: notBefore.getTime(),
      }),
      verifiedAtMs: now.getTime(),
      tokenSha256: createHash("sha256").update(bearer).digest("hex"),
    });
    this.#verified.add(principal);
    return principal;
  }

  async lock(
    transaction: ReviewRunControlTransaction,
    principal: VerifiedCurrentReviewRunPrincipal,
  ): Promise<LockedCurrentReviewRunPrincipal> {
    if (!this.#verified.has(principal)) fail();
    // TransactionClient is structurally assignable from PrismaClient in TS.
    // Prisma 7.8 supports nested $transaction on interactive clients too.
    // Its transaction proxy removes connection lifecycle methods instead; read
    // their values rather than assuming $transaction membership brands a root.
    // This guards caller misuse, not hostile in-process code forging a client.
    if (
      !transaction ||
      typeof transaction !== "object" ||
      Reflect.get(transaction, "$connect") !== undefined ||
      Reflect.get(transaction, "$disconnect") !== undefined ||
      typeof transaction.$queryRaw !== "function" ||
      typeof transaction.reviewRunAuthorization?.findUnique !== "function"
    )
      fail();
    const token = principal.token;
    await lockReviewRunControlKeys(transaction, "review-authorization", [
      `id:${token.authorizationId}`,
    ]);
    // Same production id key/derivation/order as renew and terminate. SHARE also
    // conflicts with sweep/update/delete paths that do not take advisory locks.
    const rows = await transaction.$queryRaw<
      readonly { authorizationId: string }[]
    >(
      Prisma.sql`SELECT "authorizationId" FROM "ReviewRunAuthorization"
        WHERE "authorizationId" = ${token.authorizationId} FOR SHARE`,
    );
    if (rows.length !== 1) fail();
    // Complete reread on this connection AFTER waiting, never the preflight row.
    const row = await transaction.reviewRunAuthorization.findUnique({
      where: { authorizationId: token.authorizationId },
    });
    if (!row) fail();
    const current = reviewRunAuthorizationToDomain(row);
    const scopeHash = createHash("sha256")
      .update(
        canonicalJson({
          workspaceId: current.workspaceId,
          repositoryConnectionId: current.repositoryConnectionId,
          scmRepositoryIdentityId: current.scmRepositoryIdentityId,
          pullRequestNumber: current.pullRequestNumber,
        }),
      )
      .digest("hex");
    const claimsMatch = tokenClaimsMatchAuthorization(
      {
        ...token,
        issuedAt: new Date(token.issuedAtMs),
        expiresAt: new Date(token.expiresAtMs),
      },
      current,
      scopeHash,
    );
    const { createdAt, renewedAt, expiresAt, maxExpiresAt, ...values } =
      current;
    const authorization: AuthorizationSnapshot = Object.freeze({
      ...values,
      providerVoteLanes: Object.freeze(
        values.providerVoteLanes.map((lane) => Object.freeze({ ...lane })),
      ),
      createdAtMs: createdAt.getTime(),
      renewedAtMs: renewedAt?.getTime() ?? null,
      expiresAtMs: expiresAt.getTime(),
      maxExpiresAtMs: maxExpiresAt.getTime(),
      revokedAtMs: row.revokedAt?.getTime() ?? null,
    });
    if (
      !claimsMatch ||
      current.state !== ReviewRunAuthorizationState.Active ||
      row.revokedAt !== null
    )
      fail();
    let closed = false;
    return Object.freeze({
      principal,
      authorization,
      assert(at: number): void {
        if (
          closed ||
          !Number.isFinite(at) ||
          !claimsMatch ||
          authorization.state !== ReviewRunAuthorizationState.Active ||
          authorization.revokedAtMs !== null ||
          !(
            token.notBeforeMs <= at &&
            at < token.expiresAtMs &&
            at < authorization.expiresAtMs
          )
        )
          fail();
      },
      close(): void {
        closed = true;
      },
    });
  }
}

function fail(): never {
  throw new Error("review_run_principal_not_current");
}
