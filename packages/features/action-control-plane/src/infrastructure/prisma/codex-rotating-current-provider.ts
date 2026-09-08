import { Prisma } from "@prisma/client";
import {
  assertCanonicalCodexRotatingProviderId,
  mapActiveVersionedProviderSecretNamespace,
  codexRotatingAuthMode,
  codexRotatingSecretName,
  assertExternalRecoveryWitnessAdmission,
  classifyExternalRecoveryWitnessRelation,
  fingerprintDatabaseRecoveryWitness,
  WorkflowSourceTrust,
  type VersionedSecretWorkflowSourceAttestation,
} from "@reviewrouter/features-codex-oauth-rotating";

export type LockedWorkflowAdmissionRow = Readonly<{
  id: string;
  githubRepositoryId: string;
  namespaceEpoch: bigint;
  secretName: string;
  status: string;
  permanentlyRetired: boolean;
  workflowPath: string | null;
  workflowSourceCommitSha: string | null;
  workflowSourceBlobSha: string | null;
  workflowSourceSha256: string | null;
  workflowSemanticSha256: string | null;
  workflowSourceTrust: string | null;
  workflowSchemaVersion: number | null;
  attestedRepositoryId: string | null;
  retireAt?: Date | undefined;
}>;

export function assertLockedWorkflowAdmissionMatches(input: {
  readonly persisted: LockedWorkflowAdmissionRow | null;
  readonly activeNamespace: {
    readonly id: string | null;
    readonly epoch: bigint | null;
  };
  readonly verified: VersionedSecretWorkflowSourceAttestation;
  readonly compatibility: LockedWorkflowAdmissionRow | null;
  readonly now: Date;
}): LockedWorkflowAdmissionRow {
  const { activeNamespace, verified } = input;
  const persisted =
    input.persisted?.workflowSchemaVersion === verified.workflowSchemaVersion
      ? input.persisted
      : input.compatibility?.workflowSchemaVersion ===
            verified.workflowSchemaVersion &&
          input.compatibility.retireAt !== undefined &&
          input.compatibility.retireAt > input.now
        ? input.compatibility
        : null;
  if (
    !persisted ||
    persisted.status !== "active" ||
    persisted.permanentlyRetired ||
    activeNamespace.id !== persisted.id ||
    activeNamespace.epoch !== persisted.namespaceEpoch ||
    verified.secretNamespace.namespaceId !== persisted.id ||
    verified.secretNamespace.epoch !== persisted.namespaceEpoch ||
    verified.secretNamespace.name !== persisted.secretName ||
    verified.repositoryId !== persisted.githubRepositoryId ||
    verified.repositoryId !== persisted.attestedRepositoryId ||
    verified.workflowPath !== persisted.workflowPath ||
    !persisted.workflowSourceCommitSha ||
    verified.sourceTrust !== WorkflowSourceTrust.TrustedDefaultBranchRevision ||
    verified.workflowSourceBlobSha !== persisted.workflowSourceBlobSha ||
    verified.workflowSourceSha256 !== persisted.workflowSourceSha256 ||
    verified.workflowSemanticSha256 !== persisted.workflowSemanticSha256 ||
    persisted.workflowSourceTrust !==
      WorkflowSourceTrust.TrustedDefaultBranchRevision ||
    verified.workflowSchemaVersion !== persisted.workflowSchemaVersion
  ) {
    throw new Error("codex_rotating_workflow_attestation_stale");
  }
  return persisted;
}

export function assertAutomaticRuntimeDatabaseRecoveryWitness(
  persistedFingerprint: string | null | undefined,
  currentRecoveryWitness: string | undefined,
): void {
  if (!persistedFingerprint) {
    throw new Error("codex_rotating_database_recovery_witness_unproven");
  }
  let currentFingerprint: string;
  try {
    currentFingerprint = fingerprintDatabaseRecoveryWitness(
      currentRecoveryWitness ?? "",
    );
  } catch {
    throw new Error("codex_rotating_database_recovery_witness_unproven");
  }
  assertExternalRecoveryWitnessAdmission({
    transition: "automatic_runtime",
    relation: classifyExternalRecoveryWitnessRelation({
      persistedFingerprint,
      currentFingerprint,
    }),
  });
}

/** Caller owns scope/drain guards and the READ COMMITTED transaction lifetime.
 * Missing rows reject; this view never acquires a provider lease or reads secrets.
 * Time-dependent eligibility must be checked again at final archive storage time.
 */
export async function readLockedCodexRotatingCurrentProvider(
  tx: Prisma.TransactionClient,
  scope: Readonly<{
    workspaceId: string;
    repositoryId: string;
    githubRepositoryId: string;
    providerInstanceId: string;
  }>,
) {
  if (
    typeof (tx as unknown as { $connect?: unknown }).$connect === "function" ||
    typeof (tx as unknown as { $disconnect?: unknown }).$disconnect ===
      "function"
  ) {
    throw new Error("codex_rotating_transaction_required");
  }
  assertCanonicalCodexRotatingProviderId(scope);
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "CodexOAuthProviderInstance"
    WHERE "providerInstanceId" = ${scope.providerInstanceId} FOR SHARE
  `);
  if (locked.length !== 1) throw new Error("codex_rotating_provider_not_found");
  const provider = await tx.codexOAuthProviderInstance.findUnique({
    where: { id: locked[0]!.id },
    select: {
      id: true,
      workspaceId: true,
      repositoryId: true,
      providerInstanceId: true,
      authMode: true,
      secretName: true,
      state: true,
      mutationEpoch: true,
      mutationOwner: true,
      mutationOwnerId: true,
      activeLeaseId: true,
      activeLeaseExpiresAt: true,
      activeSecretNamespaceId: true,
      activeSecretNamespaceEpoch: true,
      activeSecretNamespaceName: true,
    },
  });
  if (
    !provider ||
    provider.workspaceId !== scope.workspaceId ||
    provider.repositoryId !== scope.repositoryId ||
    provider.providerInstanceId !== scope.providerInstanceId ||
    provider.authMode !== codexRotatingAuthMode ||
    provider.secretName !== codexRotatingSecretName
  ) {
    throw new Error("codex_rotating_provider_identity_mismatch");
  }
  if (!provider.activeSecretNamespaceId)
    throw new Error("codex_rotating_namespace_missing");
  const namespaces = await tx.$queryRaw<
    Array<
      LockedWorkflowAdmissionRow & {
        providerInstanceRowId: string;
        databaseRecoveryWitness: string | null;
      }
    >
  >(Prisma.sql`
    SELECT "id", "providerInstanceRowId", "githubRepositoryId", "namespaceEpoch",
      "secretName", "status", "permanentlyRetired", "workflowPath",
      "workflowSourceCommitSha", "workflowSourceBlobSha", "workflowSourceSha256",
      "workflowSemanticSha256", "workflowSourceTrust", "workflowSchemaVersion",
      "attestedRepositoryId", "databaseRecoveryWitness"
    FROM "CodexOAuthSecretNamespace"
    WHERE "id" = ${provider.activeSecretNamespaceId}
      AND "providerInstanceRowId" = ${provider.id} FOR SHARE
  `);
  const namespace = namespaces.length === 1 ? namespaces[0] : undefined;
  if (
    !namespace ||
    namespace.githubRepositoryId !== scope.githubRepositoryId ||
    namespace.namespaceEpoch !== provider.activeSecretNamespaceEpoch ||
    namespace.secretName !== provider.activeSecretNamespaceName ||
    namespace.status !== "active" ||
    namespace.permanentlyRetired
  ) {
    throw new Error("codex_rotating_namespace_mismatch");
  }
  // Provider UPDATE is held by every participating child eligibility writer.
  // Read all relevant deadlines now, never cache a time-dependent boolean.
  const intents = await tx.codexOAuthWritebackIntent.findMany({
    where: {
      providerInstanceRowId: provider.id,
      status: { in: ["pending", "remote_outcome_unknown"] },
    },
    select: { id: true, status: true, recoveryResolvedAt: true },
  });
  const manifests = await tx.codexOAuthSetupManifest.findMany({
    where: {
      providerInstanceRowId: provider.id,
      status: { in: ["issued", "fetched"] },
    },
    select: { id: true, status: true, expiresAt: true },
  });
  const canonicalNamespace = mapActiveVersionedProviderSecretNamespace({
    scope: {
      repositoryId: scope.githubRepositoryId,
      providerInstanceId: scope.providerInstanceId,
    },
    row: { ...provider, activeSecretNamespace: namespace },
  });
  const compatibilityRows = await tx.$queryRaw<
    LockedWorkflowAdmissionRow[]
  >(Prisma.sql`
    SELECT namespace."id", namespace."githubRepositoryId", namespace."namespaceEpoch",
      namespace."secretName", namespace."status", namespace."permanentlyRetired",
      compatibility."workflowPath", compatibility."workflowSourceCommitSha",
      compatibility."workflowSourceBlobSha", compatibility."workflowSourceSha256",
      compatibility."workflowSemanticSha256", compatibility."workflowSourceTrust",
      compatibility."workflowSchemaVersion", compatibility."attestedRepositoryId", compatibility."retireAt"
    FROM "CodexOAuthWorkflowCompatibility" compatibility
    JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = compatibility."namespaceId"
    WHERE namespace."id" = ${namespace.id} AND namespace."providerInstanceRowId" = ${provider.id}
  `);
  if (compatibilityRows.length > 1)
    throw new Error("codex_rotating_workflow_compatibility_ambiguous");
  const lease = provider.activeLeaseId
    ? await tx.codexOAuthLease.findUnique({
        where: { id: provider.activeLeaseId },
        select: {
          id: true,
          providerInstanceRowId: true,
          githubRunId: true,
          githubRunAttempt: true,
          pullRequestNumber: true,
          status: true,
          expiresAt: true,
          mutationEpoch: true,
          secretNamespaceId: true,
          secretNamespaceEpoch: true,
        },
      })
    : null;
  if (lease && lease.providerInstanceRowId !== provider.id)
    throw new Error("codex_rotating_lease_scope_mismatch");
  return {
    provider,
    namespace,
    canonicalNamespace,
    compatibility: compatibilityRows[0] ?? null,
    lease,
    intents,
    manifests,
  };
}

export type LockedCodexRotatingCurrentProvider = Awaited<
  ReturnType<typeof readLockedCodexRotatingCurrentProvider>
>;

/** New work only. Existing-lease commands and receipt recovery have distinct admission contracts. */
export function assertLockedCodexRotatingNewWork(input: {
  readonly view: LockedCodexRotatingCurrentProvider;
  readonly at: Date;
  readonly verified: VersionedSecretWorkflowSourceAttestation;
  readonly currentRecoveryWitness: string | undefined;
  readonly newWorkAdmissionBarrier: { assertAdmitted(): void };
}): LockedWorkflowAdmissionRow {
  if (!Number.isFinite(input.at.getTime()))
    throw new Error("codex_rotating_storage_time_invalid");
  const { provider, namespace, compatibility, intents, manifests, lease } =
    input.view;
  const selected = assertLockedWorkflowAdmissionMatches({
    persisted: namespace,
    compatibility,
    activeNamespace: {
      id: provider.activeSecretNamespaceId,
      epoch: provider.activeSecretNamespaceEpoch,
    },
    verified: input.verified,
    now: input.at,
  });
  assertAutomaticRuntimeDatabaseRecoveryWitness(
    namespace.databaseRecoveryWitness,
    input.currentRecoveryWitness,
  );
  input.newWorkAdmissionBarrier.assertAdmitted();
  if (
    ["unknown_auth_state", "needs_reconnect", "permission_required"].includes(
      provider.state,
    )
  ) {
    throw new Error(`codex_rotating_provider_${provider.state}`);
  }
  if (
    provider.mutationOwner === "setup" ||
    provider.mutationOwner === "recovery" ||
    intents.some(
      (row) =>
        row.status === "pending" ||
        (row.status === "remote_outcome_unknown" &&
          row.recoveryResolvedAt === null),
    ) ||
    manifests.some(
      (row) =>
        row.status === "fetched" ||
        (row.status === "issued" && row.expiresAt > input.at),
    )
  ) {
    throw new Error("codex_rotating_mutation_fence_conflict");
  }
  if (
    provider.activeLeaseId &&
    provider.activeLeaseExpiresAt &&
    provider.activeLeaseExpiresAt > input.at
  ) {
    // This is a fresh-work predicate, never a replay or continuation policy.
    if (
      !lease ||
      (lease.status !== "completed" && lease.expiresAt > input.at)
    ) {
      throw new Error("codex_rotating_active_lease_conflict");
    }
  }
  return selected;
}

/** Lease fence only; the caller must also validate principal and command-specific workflow/witness evidence. */
export function assertLockedCodexRotatingLeaseFence(input: {
  readonly view: LockedCodexRotatingCurrentProvider;
  readonly at: Date;
  readonly leaseId: string;
  readonly githubRunId: string;
  readonly githubRunAttempt: string;
  readonly pullRequestNumber: number;
  readonly status: "preleased" | "finalized";
}): void {
  const { provider, lease, namespace } = input.view;
  if (!Number.isFinite(input.at.getTime()))
    throw new Error("codex_rotating_storage_time_invalid");
  if (
    !lease ||
    lease.id !== input.leaseId ||
    provider.activeLeaseId !== lease.id ||
    lease.providerInstanceRowId !== provider.id ||
    provider.mutationOwner !== "runtime" ||
    provider.mutationOwnerId !== lease.id ||
    lease.mutationEpoch !== provider.mutationEpoch ||
    lease.githubRunId !== input.githubRunId ||
    lease.githubRunAttempt !== input.githubRunAttempt ||
    lease.pullRequestNumber !== input.pullRequestNumber ||
    lease.status !== input.status ||
    lease.secretNamespaceId !== namespace.id ||
    lease.secretNamespaceEpoch !== namespace.namespaceEpoch ||
    !provider.activeLeaseExpiresAt ||
    !(provider.activeLeaseExpiresAt > input.at) ||
    !(lease.expiresAt > input.at)
  ) {
    throw new Error("codex_rotating_lease_not_active");
  }
}

/** Current-adapter handle. Acquire after scope/drain guards and close in the
 * owning transaction's finally, including rollback. It does not extend SQL lock
 * lifetime or authenticate a command. Assertions run immediately before storage,
 * after every downstream wait, using that transaction's freshly sampled DB time.
 */
export async function lockCodexRotatingCurrentProvider(
  tx: Prisma.TransactionClient,
  scope: Parameters<typeof readLockedCodexRotatingCurrentProvider>[1],
) {
  // Keep decision inputs private, including Date internal slots. Object.freeze
  // alone would still allow callers to extend a deadline with Date.setTime().
  const view = structuredClone(
    await readLockedCodexRotatingCurrentProvider(tx, scope),
  );
  const { activeLeaseExpiresAt, ...provider } = view.provider;
  const compatibility =
    view.compatibility === null
      ? null
      : Object.freeze({
          ...workflowSnapshot(view.compatibility),
          retireAtMs: view.compatibility.retireAt?.getTime() ?? null,
        });
  const lease =
    view.lease === null
      ? null
      : (() => {
          const { expiresAt, ...values } = view.lease;
          return Object.freeze({ ...values, expiresAtMs: expiresAt.getTime() });
        })();
  const snapshot = Object.freeze({
    provider: Object.freeze({
      ...provider,
      activeLeaseExpiresAtMs: activeLeaseExpiresAt?.getTime() ?? null,
    }),
    namespace: Object.freeze({
      ...workflowSnapshot(view.namespace),
      providerInstanceRowId: view.namespace.providerInstanceRowId,
      databaseRecoveryWitness: view.namespace.databaseRecoveryWitness,
    }),
    canonicalNamespace: Object.freeze({
      ...view.canonicalNamespace,
      scope: Object.freeze({ ...view.canonicalNamespace.scope }),
    }),
    compatibility,
    lease,
    intents: Object.freeze(
      view.intents.map(({ recoveryResolvedAt, ...intent }) =>
        Object.freeze({
          ...intent,
          recoveryResolvedAtMs: recoveryResolvedAt?.getTime() ?? null,
        }),
      ),
    ),
    manifests: Object.freeze(
      view.manifests.map(({ expiresAt, ...manifest }) =>
        Object.freeze({ ...manifest, expiresAtMs: expiresAt.getTime() }),
      ),
    ),
  });
  let closed = false;
  function assertOpen() {
    if (closed) throw new Error("codex_rotating_current_view_closed");
  }
  return Object.freeze({
    snapshot,
    assertNewWork(
      input: Omit<
        Parameters<typeof assertLockedCodexRotatingNewWork>[0],
        "view"
      >,
    ): void {
      assertOpen();
      assertLockedCodexRotatingNewWork({ ...input, view });
    },
    assertLeaseFence(
      input: Omit<
        Parameters<typeof assertLockedCodexRotatingLeaseFence>[0],
        "view"
      >,
    ): void {
      assertOpen();
      assertLockedCodexRotatingLeaseFence({ ...input, view });
    },
    close(): void {
      closed = true;
    },
  });
}

function workflowSnapshot(row: LockedWorkflowAdmissionRow) {
  return Object.freeze({
    id: row.id,
    githubRepositoryId: row.githubRepositoryId,
    namespaceEpoch: row.namespaceEpoch,
    secretName: row.secretName,
    status: row.status,
    permanentlyRetired: row.permanentlyRetired,
    workflowPath: row.workflowPath,
    workflowSourceCommitSha: row.workflowSourceCommitSha,
    workflowSourceBlobSha: row.workflowSourceBlobSha,
    workflowSourceSha256: row.workflowSourceSha256,
    workflowSemanticSha256: row.workflowSemanticSha256,
    workflowSourceTrust: row.workflowSourceTrust,
    workflowSchemaVersion: row.workflowSchemaVersion,
    attestedRepositoryId: row.attestedRepositoryId,
  });
}
