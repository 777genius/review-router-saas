import { createHash, randomUUID } from "node:crypto";
import { invocationGrantId } from "../../domain/identifiers";
import type {
  HostedCommentTokenMintLedgerPort,
  HostedCommentTokenPreparedSecretVaultPort,
} from "../ports/hosted-comment-token-mint-ledger-port";
import { hostedCommentTokenDelivery } from "../ports/hosted-comment-token-mint-ledger-port";

export interface HostedCommentTokenProviderPort {
  prepareCommentToken(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
  }): Promise<
    Readonly<{
      send(input: {
        readonly remainingBudgetMs: number;
        readonly budgetStartedAtMonotonicMs: number;
        readonly signal?: AbortSignal;
      }): ReturnType<HostedCommentTokenProviderPort["issueCommentToken"]>;
    }>
  >;
  issueCommentToken(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly token: string;
    readonly expiresAt: Date;
    readonly repository: string;
    readonly permissions: Readonly<{
      contents: "read";
      pullRequests: "write";
      issues: "write";
      statuses: "write";
    }>;
    readonly custody?: "acceptable" | "unacceptable";
    readonly custodyReason?: string;
  }>;
  revokeCommentToken?(input: {
    readonly token: string;
    readonly signal?: AbortSignal;
  }): Promise<void | Readonly<{ proof: "revoked" | "already_invalid" }>>;
}

const prepareLeaseMs = 30_000;
const mintTimeoutMs = 15_000;
// GitHub installation tokens currently live for one hour.  The extra minute is
// a fail-closed clock/skew margin for an indeterminate dispatch.
const ambiguityLifetimeMs = 61 * 60_000;

export class HostedCommentTokenMintProtocol {
  constructor(
    private readonly dependencies: {
      readonly commentTokens: HostedCommentTokenProviderPort;
      readonly clock: Readonly<{ now(): Date }>;
      readonly mintLedger: HostedCommentTokenMintLedgerPort;
      readonly secretVault: HostedCommentTokenPreparedSecretVaultPort;
      readonly monotonicClock?: Readonly<{ now(): number }>;
    },
  ) {}

  private get mintLedger(): HostedCommentTokenMintLedgerPort {
    return this.dependencies.mintLedger;
  }

  private monotonicNow(): number {
    return this.dependencies.monotonicClock?.now() ?? performance.now();
  }

  async issue(input: {
    readonly opaqueRefreshCapability: string;
    readonly idempotencyKey: string;
    readonly invocationLeaseId: string;
    readonly bindingId: string;
    readonly bindingVersion: number;
  }) {
    const requestIdHash = sha256(input.idempotencyKey);
    const token = await this.issueWithProtocol({
      purpose: "refresh",
      grantId: input.invocationLeaseId,
      bindingId: input.bindingId,
      bindingVersion: input.bindingVersion,
      logicalKeyHash: sha256(
        `refresh:${input.invocationLeaseId}:${requestIdHash}`,
      ),
      requestFingerprintHash: sha256(
        `${input.bindingId}:${input.bindingVersion}:${requestIdHash}`,
      ),
      requestIdHash,
      presentedTokenHash: hashCapability(input.opaqueRefreshCapability),
    });
    return {
      token: token.token,
      repository: token.repository,
      expiresAt: token.expiresAt.toISOString(),
      ...(token[hostedCommentTokenDelivery]
        ? {
            [hostedCommentTokenDelivery]: token[hostedCommentTokenDelivery],
          }
        : {}),
    };
  }

  async issueInitial(input: {
    readonly grantId: string;
    readonly bindingId: string;
    readonly bindingVersion: number;
    readonly invocationIdentity: string;
  }) {
    const logicalKeyHash = sha256(`initial:${input.grantId}`);
    return this.issueWithProtocol({
      purpose: "initial",
      grantId: input.grantId,
      bindingId: input.bindingId,
      bindingVersion: input.bindingVersion,
      logicalKeyHash,
      requestFingerprintHash: sha256(
        `${input.invocationIdentity}:${input.bindingId}:${input.bindingVersion}`,
      ),
    });
  }

  private async issueWithProtocol(input: {
    readonly purpose: "initial" | "refresh";
    readonly grantId: string;
    readonly bindingId: string;
    readonly bindingVersion: number;
    readonly logicalKeyHash: string;
    readonly requestFingerprintHash: string;
    readonly requestIdHash?: string;
    readonly presentedTokenHash?: string;
  }) {
    const now = this.dependencies.clock.now();
    const attemptId = `comment-mint-${input.logicalKeyHash}`;
    const ownerIdHash = sha256(randomUUID());
    const prepared = await this.mintLedger.prepare({
      mintId: attemptId,
      purpose: input.purpose,
      ownerIdHash,
      logicalKeyHash: input.logicalKeyHash,
      requestFingerprintHash: input.requestFingerprintHash,
      grantId: invocationGrantId(input.grantId),
      bindingId: input.bindingId,
      bindingVersion: input.bindingVersion,
      ...(input.presentedTokenHash
        ? { presentedTokenHash: input.presentedTokenHash }
        : {}),
      ...(input.requestIdHash ? { requestIdHash: input.requestIdHash } : {}),
      now,
      leaseExpiresAt: new Date(now.getTime() + prepareLeaseMs),
    });
    if (prepared.state !== "prepared") {
      if (prepared.state === "issued") {
        const replay = await this.mintLedger.replayAuthorized({
          mintId: prepared.mintId,
        });
        let plaintext: Uint8Array | undefined;
        try {
          plaintext = await this.dependencies.secretVault.open({
            mintId: prepared.mintId,
            workspaceId: replay.workspaceId,
            poolId: replay.poolId,
            envelope: replay.secretEnvelope,
          });
          if (sha256Bytes(plaintext) !== replay.tokenHash)
            throw new Error("hosted_comment_mint_replay_secret_hash_mismatch");
          // Vault I/O is deliberately before the final fence. No awaited work
          // may be added between this atomic authorization/delivery record and
          // constructing the synchronous return value.
          const deliveryClaimIdHash = sha256(randomUUID());
          await this.mintLedger.confirmReplayDelivery({
            mintId: prepared.mintId,
            tokenHash: replay.tokenHash,
            deliveryClaimIdHash,
          });
          const token = new TextDecoder().decode(plaintext);
          return {
            token,
            repository: replay.repositoryFullName,
            expiresAt: replay.tokenExpiresAt,
            permissions: {
              contents: "read" as const,
              pullRequests: "write" as const,
              issues: "write" as const,
              statuses: "write" as const,
            },
            [hostedCommentTokenDelivery]: () =>
              this.mintLedger.releaseDelivery({
                mintId: prepared.mintId,
                tokenHash: replay.tokenHash,
                deliveryClaimIdHash,
              }),
          };
        } finally {
          plaintext?.fill(0);
          zeroEnvelope(replay.secretEnvelope);
        }
      }
      throw new Error(`hosted_comment_mint_${prepared.state}`);
    }
    const executionAttemptId = prepared.mintId;

    // Await app authentication and serialize the body before dispatch is
    // authorized. The prepared send performs no work before its deadline check.
    let preparedRequest: Awaited<
      ReturnType<
        NonNullable<HostedCommentTokenProviderPort["prepareCommentToken"]>
      >
    > | null;
    try {
      preparedRequest =
        await this.dependencies.commentTokens.prepareCommentToken({
          githubInstallationId: prepared.githubInstallationId,
          githubRepositoryId: prepared.githubRepositoryId,
          repositoryFullName: prepared.repositoryFullName,
        });
    } catch (error) {
      await this.mintLedger.releasePrepared({
        mintId: executionAttemptId,
        ownerIdHash,
        errorCode: "provider_preflight_failed",
      });
      throw new Error("hosted_comment_mint_preflight_failed", { cause: error });
    }

    // Complete every failure-prone key-wrapping operation before POST. After a
    // bearer exists, capture is synchronous local AEAD and durable staging can
    // never be prevented by a KMS/network seal failure.
    let preparedCapture: Awaited<
      ReturnType<HostedCommentTokenPreparedSecretVaultPort["prepareSeal"]>
    >;
    try {
      preparedCapture = await this.dependencies.secretVault.prepareSeal({
        mintId: executionAttemptId,
        workspaceId: prepared.workspaceId,
        poolId: prepared.poolId,
      });
    } catch (error) {
      await this.mintLedger.releasePrepared({
        mintId: executionAttemptId,
        ownerIdHash,
        errorCode: "capture_preflight_failed",
      });
      throw new Error("hosted_comment_mint_capture_preflight_failed", {
        cause: error,
      });
    }

    const dispatchStartedAt = this.dependencies.clock.now();
    try {
      await this.mintLedger.authorizeDispatch({
        mintId: executionAttemptId,
        ownerIdHash,
        now: dispatchStartedAt,
        dispatchAuthorizedUntil: new Date(
          dispatchStartedAt.getTime() + mintTimeoutMs,
        ),
        unsafeUntil: new Date(
          dispatchStartedAt.getTime() + ambiguityLifetimeMs,
        ),
      });
    } catch (error) {
      preparedCapture.destroy();
      throw error;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, mintTimeoutMs);
    let token: Awaited<
      ReturnType<HostedCommentTokenProviderPort["issueCommentToken"]>
    >;
    try {
      // This is intentionally the last awaited operation before the single
      // provider POST. It rechecks the absolute DB deadline and all authority.
      // Anchor before starting the DB confirmation query. The transport
      // subtracts every monotonic millisecond since this instant from the DB
      // budget, so suspension and wall-clock lag can only close the window.
      const budgetStartedAtMonotonicMs = this.monotonicNow();
      const confirmation = await this.mintLedger.confirmDispatch({
        mintId: executionAttemptId,
        ownerIdHash,
      });
      token = await preparedRequest.send({
        remainingBudgetMs: confirmation.remainingBudgetMs,
        budgetStartedAtMonotonicMs,
        signal: controller.signal,
      });
    } catch (error) {
      preparedCapture.destroy();
      const completedAt = this.dependencies.clock.now();
      // Once dispatch is durable, even a reported 4xx is not authenticated
      // negative-effect evidence. Always retain the conservative quarantine.
      await this.mintLedger.finalizeOutcomeUnknown({
        mintId: executionAttemptId,
        ownerIdHash,
        now: completedAt,
        errorCode: timedOut
          ? "provider_timeout"
          : isLateSend(error)
            ? "provider_send_deadline_expired"
            : "provider_result_ambiguous",
        ...(isLateSend(error)
          ? {
              unsafeUntil: new Date(
                completedAt.getTime() + ambiguityLifetimeMs,
              ),
            }
          : {}),
      });
      throw new Error(
        timedOut
          ? "hosted_comment_mint_timeout"
          : "hosted_comment_mint_ambiguous",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    const tokenHash = sha256(token.token);
    let secretEnvelope: ReturnType<typeof preparedCapture.capture>;
    try {
      secretEnvelope = preparedCapture.capture(token.token);
    } catch (error) {
      await this.revokeUntilProven(token.token);
      throw new Error("hosted_comment_mint_capture_failed", { cause: error });
    } finally {
      preparedCapture.destroy();
    }
    if (token.custody === "unacceptable") {
      try {
        await this.revokeOrPoison(
          executionAttemptId,
          ownerIdHash,
          prepared.fenceEpoch,
          token,
          secretEnvelope,
          `minted_unacceptable:${token.custodyReason ?? "unknown"}`,
        );
      } finally {
        zeroEnvelope(secretEnvelope);
      }
      throw new Error("hosted_comment_mint_unacceptable_provider_response");
    }
    let finalized: "issued" | "revoke_pending";
    try {
      try {
        finalized = await this.mintLedger.finalizeKnownToken({
          mintId: executionAttemptId,
          ownerIdHash,
          fenceEpoch: prepared.fenceEpoch,
          tokenHash,
          tokenExpiresAt: token.expiresAt,
          secretEnvelope,
          now: this.dependencies.clock.now(),
        });
      } catch {
        // Resolve commit/result ambiguity by observation. Never issue a second POST.
        const observed = await this.mintLedger
          .observe({ mintId: executionAttemptId })
          .catch(() => null);
        if (observed?.state === "issued" && observed.tokenHash === tokenHash)
          finalized = "issued";
        else {
          await this.revokeOrPoison(
            executionAttemptId,
            ownerIdHash,
            prepared.fenceEpoch,
            token,
            secretEnvelope,
            "finalize_commit_ambiguous",
          );
          throw new Error("hosted_comment_mint_finalize_ambiguous");
        }
      }
      if (finalized !== "issued") {
        await this.revokeOrPoison(
          executionAttemptId,
          ownerIdHash,
          prepared.fenceEpoch,
          token,
          secretEnvelope,
          "finalize_authority_conflict",
        );
        throw new Error("hosted_comment_mint_finalize_conflict");
      }
      const deliveryClaimIdHash = sha256(randomUUID());
      await this.mintLedger.confirmReplayDelivery({
        mintId: executionAttemptId,
        tokenHash,
        deliveryClaimIdHash,
      });
      return {
        ...token,
        [hostedCommentTokenDelivery]: () =>
          this.mintLedger.releaseDelivery({
            mintId: executionAttemptId,
            tokenHash,
            deliveryClaimIdHash,
          }),
      };
    } finally {
      zeroEnvelope(secretEnvelope);
    }
  }

  private async revokeOrPoison(
    attemptId: string,
    ownerIdHash: string,
    fenceEpoch: bigint,
    issued: { token: string; expiresAt: Date },
    secretEnvelope: Awaited<
      ReturnType<HostedCommentTokenPreparedSecretVaultPort["seal"]>
    >,
    errorCode: string,
  ) {
    const tokenHash = sha256(issued.token);
    let attempt = 0;
    for (;;) {
      let staged = false;
      try {
        await this.mintLedger.stageRevocation({
          mintId: attemptId,
          tokenHash,
          tokenExpiresAt: issued.expiresAt,
          secretEnvelope,
          now: this.dependencies.clock.now(),
          errorCode,
        });
        staged = true;
      } catch {
        // Continue to authenticated revocation. If that also fails, control
        // remains here and retries custody; the known bearer is never dropped.
      }
      try {
        if (!this.dependencies.commentTokens.revokeCommentToken)
          throw new Error("comment_token_revoke_unavailable");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), mintTimeoutMs);
        try {
          const proof =
            await this.dependencies.commentTokens.revokeCommentToken({
              token: issued.token,
              signal: controller.signal,
            });
          if (!proof) throw new Error("comment_token_revoke_proof_missing");
          const provedCode = `${errorCode}:${proof.proof}`;
          await this.mintLedger
            .finalizeRevoked({
              mintId: attemptId,
              tokenHash,
              now: this.dependencies.clock.now(),
              evidenceHash: sha256(
                `provider-revoked:${tokenHash}:${provedCode}`,
              ),
              ownerIdHash,
              fenceEpoch,
              receipt: {
                authority: "github_token_delete",
                result: proof.proof,
              },
            })
            .catch(() => undefined);
          return;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        if (staged) {
          await this.mintLedger
            .finalizeOutcomeUnknown({
              mintId: attemptId,
              ownerIdHash,
              now: this.dependencies.clock.now(),
              errorCode,
            })
            .catch(() => undefined);
          return;
        }
        attempt += 1;
        await delay(Math.min(1_000, 25 * 2 ** Math.min(attempt, 5)));
      }
    }
  }

  private async revokeUntilProven(token: string): Promise<void> {
    let attempt = 0;
    for (;;) {
      try {
        if (!this.dependencies.commentTokens.revokeCommentToken)
          throw new Error("comment_token_revoke_unavailable");
        const proof = await this.dependencies.commentTokens.revokeCommentToken({
          token,
          signal: AbortSignal.timeout(mintTimeoutMs),
        });
        if (proof) return;
      } catch {
        attempt += 1;
        await delay(Math.min(1_000, 25 * 2 ** Math.min(attempt, 5)));
      }
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isLateSend(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "lateSend" in error &&
    (error as { lateSend?: unknown }).lateSend === true
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashCapability(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value))
    throw new Error("hosted_comment_refresh_capability_invalid");
  return sha256(value);
}

function zeroEnvelope(envelope: {
  ciphertext: Uint8Array;
  encryptedDataKey: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}) {
  envelope.ciphertext.fill(0);
  envelope.encryptedDataKey.fill(0);
  envelope.iv.fill(0);
  envelope.authTag.fill(0);
}
