import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { CanaryRunEvidence } from "./hosted-pool-production-ports";

export type CanaryPhaseScope = Readonly<{
  phase: "unauthorized" | "rate_limited" | "dropped_response";
  planIdHash: string;
  runId: number;
  repositoryId: number;
  repositoryBindingId: string;
  bindingRevision: string;
  actionSha: string;
  poolId: string;
  accountIds: readonly [string, string];
}>;

export type CanaryPhaseRecoveryPort = Readonly<{
  prepareCanaryPhase(scope: CanaryPhaseScope): Promise<void>;
  reconcileCanaryPhase(
    scope: CanaryPhaseScope,
    evidence: CanaryRunEvidence,
  ): Promise<Readonly<{ receiptId: string; status: "restored" | "unchanged" }>>;
}>;

const targetType = "hosted_codex_canary_phase_recovery";
const actor = "operator:production-canary";
const preparedAction = "hosted_codex_canary_phase_prepared";
const reconciledAction = "hosted_codex_canary_phase_reconciled";
const phases = {
  unauthorized: "synthetic_unauthorized",
  rate_limited: "synthetic_rate_limited",
  dropped_response: "drop_after_response_started",
} as const;

// Metadata only: never load ciphertext, auth.json, token envelopes or keys.
const accountSelect = {
  id: true,
  state: true,
  healthVersion: true,
  activeGeneration: true,
  cooldownUntil: true,
  drainingAt: true,
  tombstonedAt: true,
  credentialVersions: {
    orderBy: { generation: "desc" },
    take: 1,
    select: {
      id: true,
      generation: true,
      credentialExpiresAt: true,
      databaseIncarnation: true,
      envelopeRevisions: {
        orderBy: { revision: "desc" },
        take: 1,
        select: { id: true, databaseIncarnation: true },
      },
    },
  },
} as const satisfies Prisma.HostedCodexAccountSelect;

/**
 * Operator-only, bounded to one prepared phase and two dedicated accounts.
 * Source contract at 42134d9: an effect is prepared before authenticated fault
 * consumption; failover atomically terminalizes it, switches the grant and
 * increments healthVersion. Every other disposition/generation writer uses the
 * health CAS contract. A +1 health delta alone is NEVER synthetic authority.
 * AuditEvent's existing primary key supplies deterministic durable receipts;
 * serializable reads + account CAS fence races without an inference lease.
 */
export function createPrismaCanaryPhaseRecovery(
  prisma: PrismaClient,
  now: () => Date = () => new Date(),
): CanaryPhaseRecoveryPort {
  return {
    async prepareCanaryPhase(scope) {
      validateScope(scope);
      await prisma.$transaction(
        async (tx) => {
          const existing = await tx.auditEvent.findUnique({
            where: { id: preparedId(scope) },
            select: { id: true },
          });
          // Never restart a dispatched phase, even if the prepare response was lost.
          requireProof(!existing, "phase_already_prepared");
          const inventory = await readInventory(tx, scope, now());
          requireProof(
            inventory.accounts.every(
              (a) => a.state === "healthy" && a.cooldownUntil === null,
            ),
            "pool_not_healthy",
          );
          const previous = await tx.hostedCodexInvocationGrant.count({
            where: { runId: String(scope.runId), runAttempt: 2 },
          });
          requireProof(previous === 0, "run_already_dispatched");
          await assertNoPendingEffects(tx, scope);
          await tx.auditEvent.create({
            data: {
              id: preparedId(scope),
              workspaceId: inventory.workspaceId,
              actor,
              action: preparedAction,
              targetType,
              targetId: scope.planIdHash,
              metadata: json({ scope, inventory }),
            },
          });
        },
        { isolationLevel: "Serializable" },
      );
    },
    async reconcileCanaryPhase(scope, evidence) {
      validateScope(scope);
      const reconcile = async (readOnly: boolean) =>
        prisma.$transaction(
          async (tx) => {
            const prepared = await tx.auditEvent.findUnique({
              where: { id: preparedId(scope) },
            });
            requireProof(
              prepared?.action === preparedAction &&
                prepared.actor === actor &&
                prepared.targetType === targetType &&
                prepared.targetId === scope.planIdHash,
              "preparation_missing",
            );
            const snapshot = prepared.metadata as unknown as {
              scope: CanaryPhaseScope;
              inventory: Inventory;
            };
            requireProof(
              digest(snapshot.scope) === digest(scope),
              "preparation_scope_mismatch",
            );
            const inventory = await readInventory(tx, scope, now());
            requireProof(
              prepared.workspaceId === inventory.workspaceId &&
                digest({ ...inventory, accounts: [] }) ===
                  digest({ ...snapshot.inventory, accounts: [] }),
              "binding_drift",
            );
            await assertNoPendingEffects(
              tx,
              scope,
              scope.phase === "dropped_response" ? evidence.grantId : undefined,
            );
            const proof = await readPhaseProof(
              tx,
              scope,
              evidence,
              prepared.createdAt,
              now(),
            );
            requireProof(
              proof.grant.relayRequests[0]!.upstreamAttempts.every(
                (attempt) =>
                  attempt.credentialGeneration?.toString() ===
                  snapshot.inventory.accounts.find(
                    (account) => account.id === attempt.accountId,
                  )?.activeGeneration,
              ),
              "effect_generation_mismatch",
            );
            const receiptId = `canary-phase-reconciled-${scope.planIdHash}`;
            const status =
              scope.phase === "dropped_response" ? "unchanged" : "restored";
            const primaryBefore = snapshot.inventory.accounts.find(
              (a) => a.id === proof.primaryAccountId,
            )!;
            const receipt = {
              scope,
              preparationHash: digest(snapshot),
              proofHash: digest(proof),
              cooldownUntil: proof.cooldownUntil,
              accountId: proof.primaryAccountId,
              credentialGeneration: primaryBefore.activeGeneration,
              preparedHealthVersion: primaryBefore.healthVersion,
              dispositionHealthVersion: (
                BigInt(primaryBefore.healthVersion) +
                (status === "restored" ? 1n : 0n)
              ).toString(),
              reconciledHealthVersion: (
                BigInt(primaryBefore.healthVersion) +
                (status === "restored" ? 2n : 0n)
              ).toString(),
              status,
            };
            const existing = await tx.auditEvent.findUnique({
              where: { id: receiptId },
            });
            if (existing) {
              requireProof(
                existing.workspaceId === inventory.workspaceId &&
                  existing.actor === actor &&
                  existing.action === reconciledAction &&
                  existing.targetType === targetType &&
                  existing.targetId === scope.planIdHash &&
                  digest(existing.metadata) === digest(receipt),
                "receipt_mismatch",
              );
              assertAccountDelta(
                snapshot.inventory,
                inventory,
                proof.primaryAccountId,
                status === "restored" ? 2n : 0n,
                "healthy",
                null,
              );
              return { receiptId, status } as const;
            }
            // On an ambiguous commit only observe a receipt; never repeat the write.
            requireProof(!readOnly, "reconciliation_outcome_unknown");
            const failedState =
              scope.phase === "unauthorized" ? "quarantined" : "cooldown";
            assertAccountDelta(
              snapshot.inventory,
              inventory,
              proof.primaryAccountId,
              status === "restored" ? 1n : 0n,
              status === "restored" ? failedState : "healthy",
              proof.cooldownUntil,
            );
            if (status === "restored") {
              const account = inventory.accounts.find(
                (a) => a.id === proof.primaryAccountId,
              )!;
              const changed = await tx.hostedCodexAccount.updateMany({
                where: {
                  id: account.id,
                  workspaceId: inventory.workspaceId,
                  poolId: scope.poolId,
                  state: failedState,
                  healthVersion: BigInt(account.healthVersion),
                  activeGeneration: BigInt(account.activeGeneration),
                  cooldownUntil: proof.cooldownUntil
                    ? new Date(proof.cooldownUntil)
                    : null,
                  drainingAt: null,
                  tombstonedAt: null,
                },
                data: {
                  state: "healthy",
                  cooldownUntil: null,
                  healthVersion: { increment: 1 },
                },
              });
              requireProof(changed.count === 1, "health_cas_conflict");
            }
            await tx.auditEvent.create({
              data: {
                id: receiptId,
                workspaceId: inventory.workspaceId,
                actor,
                action: reconciledAction,
                targetType,
                targetId: scope.planIdHash,
                metadata: json(receipt),
              },
            });
            return { receiptId, status } as const;
          },
          { isolationLevel: "Serializable" },
        );
      try {
        return await reconcile(false);
      } catch (error) {
        try {
          return await reconcile(true);
        } catch (observationError) {
          throw new AggregateError(
            [error, observationError],
            "hosted_pool_canary_phase_recovery_hold",
            { cause: observationError },
          );
        }
      }
    },
  };
}

async function readInventory(
  tx: Prisma.TransactionClient,
  scope: CanaryPhaseScope,
  now: Date,
) {
  const bindings = await tx.hostedCodexRepositoryBinding.findMany({
    where: { poolId: scope.poolId },
    select: {
      id: true,
      workspaceId: true,
      revision: true,
      stateVersion: true,
      status: true,
      attestedBindingRevision: true,
      attestedGithubRepositoryId: true,
      workflowActionRef: true,
      workflowPath: true,
      pool: {
        select: {
          status: true,
          revision: true,
          authzEpoch: true,
          drainingAt: true,
          tombstonedAt: true,
          accounts: { select: accountSelect, orderBy: { id: "asc" } },
        },
      },
    },
  });
  const binding = bindings[0];
  requireProof(
    bindings.length === 1 &&
      binding?.id === scope.repositoryBindingId &&
      binding.status === "active" &&
      binding.revision === BigInt(scope.bindingRevision) &&
      binding.attestedBindingRevision === binding.revision &&
      binding.attestedGithubRepositoryId === BigInt(scope.repositoryId) &&
      binding.workflowActionRef ===
        `777genius/review-router@${scope.actionSha}` &&
      binding.workflowPath === ".github/workflows/reviewrouter-codex.yml" &&
      binding.pool.status === "active" &&
      !binding.pool.drainingAt &&
      !binding.pool.tombstonedAt,
    "dedicated_binding_invalid",
  );
  const accounts = binding.pool.accounts;
  requireProof(
    accounts.length === 2 &&
      digest(accounts.map((a) => a.id)) ===
        digest([...scope.accountIds].sort()),
    "dedicated_accounts_invalid",
  );
  for (const account of accounts) {
    const credential = account.credentialVersions[0];
    requireProof(
      account.activeGeneration !== null &&
        credential?.generation === account.activeGeneration &&
        account.activeGeneration > 0n &&
        !account.drainingAt &&
        !account.tombstonedAt &&
        (!credential.credentialExpiresAt ||
          credential.credentialExpiresAt > now),
      "generation_or_expiry_invalid",
    );
  }
  const restores = await tx.hostedCodexRestoreItem.count({
    where: {
      accountId: { in: [...scope.accountIds] },
      state: { not: "promoted" },
    },
  });
  requireProof(restores === 0, "restore_in_progress");
  return json({
    workspaceId: binding.workspaceId,
    bindingRevision: binding.revision,
    bindingStateVersion: binding.stateVersion,
    poolRevision: binding.pool.revision,
    poolAuthzEpoch: binding.pool.authzEpoch,
    accounts,
  }) as unknown as Inventory;
}

type Inventory = {
  workspaceId: string;
  accounts: Array<{
    id: string;
    healthVersion: string;
    activeGeneration: string;
    state: string;
    cooldownUntil: string | null;
  }>;
};

function assertAccountDelta(
  before: Inventory,
  after: Inventory,
  primaryId: string,
  delta: bigint,
  state: string,
  cooldownUntil: string | null,
) {
  requireProof(
    before.accounts.length === 2 &&
      before.accounts.some((a) => a.id === primaryId),
    "snapshot_invalid",
  );
  const expected = before.accounts.map((account) =>
    account.id === primaryId
      ? {
          ...account,
          healthVersion: (BigInt(account.healthVersion) + delta).toString(),
          state,
          cooldownUntil,
        }
      : account,
  );
  requireProof(
    digest(expected) === digest(after.accounts),
    "account_health_or_generation_drift",
  );
}

async function assertNoPendingEffects(
  tx: Prisma.TransactionClient,
  scope: CanaryPhaseScope,
  allowedDroppedGrant?: string,
) {
  const pending = await tx.hostedCodexRelayRequest.count({
    where: {
      grant: { poolId: scope.poolId },
      status: { in: ["received", "processing", "response_started"] },
    },
  });
  const effects = await tx.hostedCodexUpstreamEffectAttempt.count({
    where: {
      poolId: scope.poolId,
      state: { in: ["prepared", "dispatching", "response_started"] },
    },
  });
  const unknown = await tx.hostedCodexUpstreamEffectAttempt.count({
    where: {
      poolId: scope.poolId,
      state: "terminal_unknown",
      ...(allowedDroppedGrant ? { grantId: { not: allowedDroppedGrant } } : {}),
    },
  });
  requireProof(
    pending === 0 && effects === 0 && unknown === 0,
    "pending_effects",
  );
}

async function readPhaseProof(
  tx: Prisma.TransactionClient,
  scope: CanaryPhaseScope,
  observed: CanaryRunEvidence,
  preparedAt: Date,
  now: Date,
) {
  requireProof(
    /^[a-f0-9]{40}$/u.test(observed.sourceHeadSha) &&
      typeof observed.sourceExecutionId === "string" &&
      observed.sourceExecutionId.length > 0 &&
      observed.runId === scope.runId &&
      observed.sourceRunAttempt === 2 &&
      observed.repositoryBindingId === scope.repositoryBindingId &&
      observed.bindingRevision === scope.bindingRevision &&
      observed.actionRef === `777genius/review-router@${scope.actionSha}` &&
      observed.githubRepositoryId === String(scope.repositoryId),
    "observed_scope_mismatch",
  );
  const grants = await tx.hostedCodexInvocationGrant.findMany({
    where: { runId: String(scope.runId), runAttempt: 2 },
    select: {
      id: true,
      workspaceId: true,
      poolId: true,
      repositoryBindingId: true,
      bindingRevision: true,
      primaryAccountId: true,
      backupAccountId: true,
      activeAccountId: true,
      failoverCount: true,
      issuedAt: true,
      expiresAt: true,
      status: true,
      revokedAt: true,
      inFlight: true,
      requestCount: true,
      reviewRequestId: true,
      commentRefreshCapability: { select: { revokedAt: true } },
      relayRequests: {
        select: {
          id: true,
          ordinal: true,
          status: true,
          errorCode: true,
          completedAt: true,
          upstreamAttempts: {
            orderBy: { attemptOrdinal: "asc" },
            select: {
              id: true,
              grantId: true,
              relayRequestId: true,
              accountId: true,
              credentialGeneration: true,
              fenceEpoch: true,
              attemptOrdinal: true,
              state: true,
              dispatchStartedAt: true,
              responseStartedAt: true,
              completedAt: true,
              createdAt: true,
              terminalEvidenceHash: true,
              providerResponseIdHash: true,
              errorCode: true,
            },
          },
        },
      },
    },
  });
  const grant = grants[0];
  requireProof(
    grants.length === 1 &&
      grant?.id === observed.grantId &&
      grant.workspaceId === observed.workspaceId &&
      grant.poolId === scope.poolId &&
      grant.repositoryBindingId === scope.repositoryBindingId &&
      grant.bindingRevision === BigInt(scope.bindingRevision) &&
      grant.issuedAt >= preparedAt &&
      grant.expiresAt > now &&
      grant.inFlight === 0 &&
      grant.requestCount === 1 &&
      grant.relayRequests.length === 1 &&
      scope.accountIds.includes(grant.primaryAccountId) &&
      scope.accountIds.includes(grant.backupAccountId ?? "") &&
      grant.primaryAccountId !== grant.backupAccountId,
    "grant_graph_invalid",
  );
  const source = await tx.reviewRequestedIntent.findUnique({
    where: { requestId: grant.reviewRequestId },
    select: {
      headSha: true,
      sourceRunId: true,
      sourceRunAttempt: true,
      executionId: true,
    },
  });
  requireProof(
    source?.headSha === observed.sourceHeadSha &&
      source.sourceRunId === String(scope.runId) &&
      source.sourceRunAttempt === "2" &&
      source.executionId === observed.sourceExecutionId,
    "source_mismatch",
  );
  const request = grant.relayRequests[0]!;
  const attempt = request.upstreamAttempts[0];
  requireProof(
    request.id === observed.requestId &&
      request.ordinal === 1 &&
      request.completedAt !== null &&
      request.upstreamAttempts.length === observed.attempts.length &&
      request.upstreamAttempts.every(
        (a, i) =>
          a.id === observed.attempts[i]?.attemptId &&
          a.grantId === grant.id &&
          a.relayRequestId === request.id &&
          a.attemptOrdinal === i + 1 &&
          a.credentialGeneration?.toString() ===
            observed.attempts[i]?.credentialGeneration,
      ),
    "effect_graph_invalid",
  );
  requireProof(
    attempt?.accountId === grant.primaryAccountId &&
      attempt.completedAt !== null,
    "primary_effect_invalid",
  );
  const events = await tx.auditEvent.findMany({
    where: {
      workspaceId: grant.workspaceId,
      action: "hosted_codex_canary_fault_plan_consumed",
      metadata: { path: ["runId"], equals: String(scope.runId) },
    },
  });
  const event = events[0];
  const consumption = event?.metadata as Record<string, unknown> | undefined;
  requireProof(
    events.length === 1 &&
      event?.targetType === "hosted_codex_canary_fault_plan" &&
      event.targetId === scope.planIdHash &&
      consumption?.planIdHash === scope.planIdHash &&
      consumption.phase === phases[scope.phase] &&
      consumption.runId === String(scope.runId) &&
      consumption.runAttempt === 2 &&
      consumption.repositoryId === String(scope.repositoryId) &&
      consumption.actionRef === `777genius/review-router@${scope.actionSha}` &&
      consumption.bindingId === scope.repositoryBindingId &&
      consumption.bindingRevision === scope.bindingRevision &&
      consumption.requestOrdinal === 1 &&
      consumption.attemptOrdinal === 1 &&
      consumption.injectionPoint ===
        (scope.phase === "dropped_response"
          ? "after_response_started"
          : "before_provider_fetch") &&
      event.createdAt >= attempt.createdAt &&
      event.createdAt <= attempt.completedAt &&
      typeof consumption.expiresAt === "string" &&
      new Date(consumption.expiresAt) > event.createdAt,
    "authenticated_consumption_missing",
  );
  const staged = await tx.auditEvent.findMany({
    where: {
      workspaceId: grant.workspaceId,
      targetType: "hosted_codex_canary_fault_plan",
      targetId: scope.planIdHash,
      action: {
        in: [
          "hosted_codex_canary_fault_plan_staged",
          "hosted_codex_canary_fault_plan_canceled",
        ],
      },
    },
    select: { action: true, createdAt: true },
  });
  requireProof(
    staged.length === 1 &&
      staged[0]!.action === "hosted_codex_canary_fault_plan_staged" &&
      staged[0]!.createdAt >= preparedAt &&
      staged[0]!.createdAt <= event.createdAt,
    "stage_not_consumed_exclusively",
  );
  let cooldownUntil: string | null = null;
  if (scope.phase === "dropped_response") {
    requireProof(
      grant.status === "revoked" &&
        grant.revokedAt !== null &&
        grant.commentRefreshCapability?.revokedAt != null &&
        grant.activeAccountId === grant.primaryAccountId &&
        grant.failoverCount === 0 &&
        request.status === "terminal_unknown" &&
        request.errorCode === "ambiguous_dropped_response" &&
        request.upstreamAttempts.length === 1 &&
        attempt.state === "terminal_unknown" &&
        attempt.errorCode === "ambiguous_dropped_response" &&
        attempt.dispatchStartedAt !== null &&
        attempt.responseStartedAt !== null &&
        attempt.terminalEvidenceHash ===
          createHash("sha256")
            .update(
              `operator-canary-dropped-response\0${attempt.id}\0${attempt.fenceEpoch}`,
            )
            .digest("hex"),
      "dropped_outcome_unproved",
    );
  } else {
    const status = scope.phase === "unauthorized" ? 401 : 429;
    const backup = request.upstreamAttempts[1];
    requireProof(
      (grant.status === "exhausted" || grant.status === "issued") &&
        grant.revokedAt === null &&
        grant.failoverCount === 1 &&
        grant.activeAccountId === grant.backupAccountId &&
        request.status === "succeeded" &&
        request.errorCode === null &&
        request.upstreamAttempts.length === 2 &&
        attempt.state === "failed_no_effect" &&
        attempt.dispatchStartedAt === null &&
        attempt.responseStartedAt === null &&
        attempt.providerResponseIdHash === null &&
        attempt.errorCode ===
          (status === 401 ? "credential_invalid" : "quota_limited") &&
        attempt.terminalEvidenceHash ===
          createHash("sha256")
            .update(`prepared\0${status}\0${attempt.id}`)
            .digest("hex") &&
        backup?.accountId === grant.backupAccountId &&
        backup.state === "succeeded" &&
        backup.errorCode === null &&
        backup.createdAt >= attempt.completedAt &&
        backup.dispatchStartedAt !== null &&
        backup.responseStartedAt !== null &&
        backup.completedAt !== null &&
        /^[a-f0-9]{64}$/u.test(backup.providerResponseIdHash ?? ""),
      "synthetic_disposition_unproved",
    );
    // Runtime computes cooldown immediately before failover's timestamp. Check
    // its exact stored value below, and bound it to that call's 15-minute plan.
    if (status === 429) {
      const failed = await tx.hostedCodexAccount.findUnique({
        where: { id: grant.primaryAccountId },
        select: { cooldownUntil: true },
      });
      // On receipt replay the cooldown has already been cleared: derive the
      // original value from the receipt's proof rather than guessing a timestamp.
      const receipt = await tx.auditEvent.findUnique({
        where: { id: `canary-phase-reconciled-${scope.planIdHash}` },
      });
      const saved = receipt?.metadata as Record<string, unknown> | undefined;
      cooldownUntil =
        failed?.cooldownUntil?.toISOString() ??
        (typeof saved?.cooldownUntil === "string" ? saved.cooldownUntil : null);
      requireProof(
        cooldownUntil !== null &&
          new Date(cooldownUntil).getTime() >=
            event.createdAt.getTime() + 15 * 60_000 &&
          new Date(cooldownUntil).getTime() <=
            attempt.completedAt.getTime() + 15 * 60_000,
        "synthetic_cooldown_unproved",
      );
    }
  }
  return {
    grant,
    source,
    consumption: event,
    primaryAccountId: grant.primaryAccountId,
    cooldownUntil,
  };
}

function validateScope(scope: CanaryPhaseScope) {
  requireProof(
    Object.hasOwn(phases, scope.phase) &&
      /^[a-f0-9]{64}$/u.test(scope.planIdHash) &&
      /^[a-f0-9]{40}$/u.test(scope.actionSha) &&
      /^[1-9]\d*$/u.test(scope.bindingRevision) &&
      Number.isSafeInteger(scope.runId) &&
      scope.runId > 0 &&
      Number.isSafeInteger(scope.repositoryId) &&
      scope.repositoryId > 0 &&
      scope.accountIds.length === 2 &&
      new Set(scope.accountIds).size === 2 &&
      [scope.poolId, scope.repositoryBindingId, ...scope.accountIds].every(
        (id) => id.length > 0,
      ),
    "scope_invalid",
  );
}
function preparedId(scope: CanaryPhaseScope) {
  return `canary-phase-prepared-${scope.planIdHash}`;
}
function requireProof(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`hosted_pool_canary_phase_${reason}`);
}
function json(value: unknown): Prisma.InputJsonObject {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  );
}
function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) => {
        if (typeof item === "bigint") return item.toString();
        if (item && typeof item === "object" && !Array.isArray(item))
          return Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          );
        return item;
      }),
    )
    .digest("hex");
}
