import { createHash, randomUUID } from "node:crypto";
import type {
  HostedCommentTokenMintLedgerPort,
  HostedCommentTokenRevocationProviderPort,
  HostedCommentTokenSecretVaultPort,
} from "../ports/hosted-comment-token-mint-ledger-port";

export type HostedCommentTokenClosureReconcileResult = Readonly<{
  claimed: number;
  revoked: number;
  deferred: number;
}>;

export class HostedCommentTokenClosureReconciler {
  private readonly ownerIdHash: string;

  constructor(
    private readonly dependencies: {
      readonly ledger: HostedCommentTokenMintLedgerPort;
      readonly vault: HostedCommentTokenSecretVaultPort;
      readonly provider: HostedCommentTokenRevocationProviderPort;
      readonly now: () => Date;
      readonly batchSize?: number;
      readonly leaseMs?: number;
      readonly providerTimeoutMs?: number;
      readonly ownerIdHash?: string;
    },
  ) {
    this.ownerIdHash = dependencies.ownerIdHash ?? sha256(randomUUID());
  }

  /**
   * Upper bound for the cancellable secret/provider work represented by one
   * lease. Each claim can consume one vault-open deadline and one provider
   * deadline, sequentially. The final allowance is reserved for the short
   * database transitions around that work.
   */
  maximumRunMs(): number {
    const { batchSize, providerTimeoutMs } = this.timing();
    return Math.max(
      this.dependencies.leaseMs ?? 30_000,
      providerTimeoutMs * batchSize * 2 + 5_000,
    );
  }

  async reconcile(): Promise<HostedCommentTokenClosureReconcileResult> {
    const now = this.dependencies.now();
    const { batchSize, providerTimeoutMs } = this.timing();
    const leaseMs = this.maximumRunMs();
    // This database-only pass is intentionally independent of relay serving.
    // It cannot dispatch provider work; it merely advances rows after their
    // durable lease/ambiguity barriers have elapsed.
    await this.dependencies.ledger.recoverStale({ limit: batchSize });
    const claims = await this.dependencies.ledger.claimRevocations({
      ownerIdHash: this.ownerIdHash,
      now,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      limit: batchSize,
    });
    let revoked = 0;
    let deferred = 0;
    const releaseFailures: unknown[] = [];
    try {
      for (const claim of claims) {
        let plaintext: Uint8Array | undefined;
        try {
          const vaultController = new AbortController();
          const vaultTimer = setTimeout(
            () => vaultController.abort(),
            providerTimeoutMs,
          );
          try {
            plaintext = await this.dependencies.vault.open({
              mintId: claim.mintId,
              workspaceId: claim.workspaceId,
              poolId: claim.poolId,
              envelope: claim.secretEnvelope,
              signal: vaultController.signal,
            });
          } finally {
            clearTimeout(vaultTimer);
          }
          if (sha256Bytes(plaintext) !== claim.tokenHash)
            throw new Error(
              "hosted_comment_token_revocation_secret_hash_mismatch",
            );
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), providerTimeoutMs);
          let evidence: Awaited<
            ReturnType<HostedCommentTokenRevocationProviderPort["revoke"]>
          >;
          try {
            evidence = await this.dependencies.provider.revoke({
              token: new TextDecoder().decode(plaintext),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          await this.dependencies.ledger.finalizeRevoked({
            mintId: claim.mintId,
            tokenHash: claim.tokenHash,
            now: this.dependencies.now(),
            evidenceHash: sha256(`${claim.tokenHash}:${evidence.evidenceHash}`),
            ownerIdHash: claim.ownerIdHash,
            fenceEpoch: claim.fenceEpoch,
            receipt: evidence.receipt,
          });
          revoked += 1;
        } catch (error) {
          try {
            await this.dependencies.ledger.releaseRevocation({
              mintId: claim.mintId,
              ownerIdHash: claim.ownerIdHash,
              fenceEpoch: claim.fenceEpoch,
              now: this.dependencies.now(),
              errorCode: classifyRevocationFailure(error),
            });
          } catch (releaseError) {
            releaseFailures.push(releaseError);
          }
          deferred += 1;
        } finally {
          plaintext?.fill(0);
          zeroEnvelope(claim.secretEnvelope);
        }
      }
    } finally {
      // Claims are materialized as a batch. Always clear even claims that were
      // never reached because an unexpected control-flow failure escaped.
      for (const claim of claims) zeroEnvelope(claim.secretEnvelope);
    }
    if (releaseFailures.length > 0)
      throw new AggregateError(
        releaseFailures,
        "hosted_comment_token_revocation_release_failed",
      );
    return { claimed: claims.length, revoked, deferred };
  }

  private timing() {
    return {
      providerTimeoutMs: Math.max(
        1,
        Math.floor(this.dependencies.providerTimeoutMs ?? 15_000),
      ),
      batchSize: Math.min(
        16,
        Math.max(1, Math.floor(this.dependencies.batchSize ?? 4)),
      ),
    };
  }
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

export function startHostedCommentTokenClosureReconciler(
  reconciler: HostedCommentTokenClosureReconciler,
  intervalMs = 5_000,
): HostedCommentTokenClosureReconcilerHandle {
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeRun: Promise<void> | null = null;
  let consecutiveFailures = 0;
  let attempts = 0;
  let successes = 0;
  let lastFailureAt: Date | null = null;
  let runStartedAt: Date | null = null;
  const overdueRunMs = Math.max(reconciler.maximumRunMs(), intervalMs * 12);
  const schedule = () => {
    if (stopped) return;
    const delay = Math.min(intervalMs * 2 ** consecutiveFailures, 60_000);
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };
  const tick = () => {
    if (running || stopped) return Promise.resolve();
    running = true;
    activeRun = (async () => {
      attempts += 1;
      runStartedAt = new Date();
      try {
        await reconciler.reconcile();
        successes += 1;
        consecutiveFailures = 0;
      } catch {
        consecutiveFailures = Math.min(consecutiveFailures + 1, 8);
        lastFailureAt = new Date();
      } finally {
        running = false;
        runStartedAt = null;
        activeRun = null;
        schedule();
      }
    })();
    return activeRun;
  };
  void tick();
  const stop = (async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await activeRun;
  }) as HostedCommentTokenClosureReconcilerHandle;
  stop.health = () => {
    const overdue =
      running &&
      runStartedAt !== null &&
      Date.now() - runStartedAt.getTime() >= overdueRunMs;
    return {
      status: consecutiveFailures >= 3 || overdue ? "degraded" : "ok",
      metrics: {
        attempts,
        successes,
        consecutiveFailures,
        running,
        lastFailureAt: lastFailureAt?.toISOString() ?? null,
        overdue,
      },
    };
  };
  return stop;
}

export type HostedCommentTokenClosureReconcilerHandle =
  (() => Promise<void>) & {
    health(): Readonly<{
      status: "ok" | "degraded";
      metrics: Readonly<{
        attempts: number;
        successes: number;
        consecutiveFailures: number;
        running: boolean;
        lastFailureAt: string | null;
        overdue: boolean;
      }>;
    }>;
  };

function classifyRevocationFailure(error: unknown): string {
  if (hasAbortCause(error)) return "custody_or_provider_timeout";
  if (
    error instanceof Error &&
    error.message === "hosted_comment_token_revocation_secret_hash_mismatch"
  )
    return "revocation_secret_hash_mismatch";
  return "provider_revoke_ambiguous";
}

function hasAbortCause(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (
    current instanceof Error &&
    !visited.has(current) &&
    visited.size < 8
  ) {
    if (current.name === "AbortError") return true;
    visited.add(current);
    current = current.cause;
  }
  return false;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
