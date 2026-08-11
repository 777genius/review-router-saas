import { createHash } from "node:crypto";
import { createPrismaClient } from "../packages/platform/db/src/index";
import {
  createVersionedSecretWorkflowSourceAttestation,
  createVersionedProviderSecretNamespace,
  WorkflowSourceTrust,
} from "../packages/features/codex-oauth-rotating/src/index";
import {
  codexRotatingSetupManifestSchema,
  codexRotatingSetupRecoveryAcknowledgement,
  recoverCodexRotatingSetup,
} from "../packages/features/provider-setup/src/index";
import { PrismaCodexRotatingOAuthRepository } from "../packages/features/action-control-plane/src/infrastructure/prisma/prisma-codex-rotating-oauth-repository";
import {
  issueCodexRotatingSetupCommand,
  resolveCodexRotatingSetupManifestForNonce,
} from "../apps/web/src/server/codex-rotating-setup-manifest";
import { PrismaCodexRotatingSetupRecovery } from "../apps/web/src/server/prisma-codex-rotating-setup-recovery";
import { PrismaCodexRotatingSetupPayloadClaim } from "../apps/web/src/server/prisma-codex-rotating-setup-payload-claim";

const databaseUrl = process.env.REVIEW_ROUTER_PRISMA_EVIDENCE_DATABASE_URL;
if (!databaseUrl)
  throw new Error("runtime versioned writeback proof URL required");
const prisma = createPrismaClient({ databaseUrl });
const providerInstanceId = "codex-rotating:900007";
const providerRowId = "p-clean";
const accountIdentityHash = "a".repeat(64);
const databaseRecoveryWitnessW1 = "r".repeat(43);
const databaseRecoveryWitnessW2 = "s".repeat(43);
const localProofRuntimeEnvironment: NodeJS.ProcessEnv = {
  REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED: "1",
  REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "1",
  REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES: "local/proof-7",
};
const attestationFor = (
  namespace: Parameters<
    typeof createVersionedSecretWorkflowSourceAttestation
  >[0]["secretNamespace"],
  marker: string,
) =>
  createVersionedSecretWorkflowSourceAttestation({
    repositoryId: "900007",
    workflowPath: ".github/workflows/reviewrouter-codex.yml",
    workflowSourceCommitSha: marker.repeat(40),
    workflowSourceBlobSha: marker.repeat(40),
    workflowSourceSha256: marker.repeat(64),
    workflowSemanticSha256: marker.repeat(64),
    sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
    secretNamespace: namespace,
  });

try {
  const now = new Date("2026-08-10T12:00:00.000Z");
  await prisma.gitHubInstallation.create({
    data: {
      id: "runtime-proof-installation",
      workspaceId: "ws-proof",
      githubInstallationId: 990007n,
      accountLogin: "local",
      accountType: "Organization",
      repositorySelection: "selected",
    },
  });
  await prisma.repositoryConnection.update({
    where: { id: "repo-7" },
    data: { installationId: "runtime-proof-installation" },
  });
  const row = await prisma.repositoryConnection.findUniqueOrThrow({
    where: { id: "repo-7" },
    select: {
      id: true,
      workspaceId: true,
      githubRepositoryId: true,
      fullName: true,
      owner: true,
      installation: { select: { githubInstallationId: true, status: true } },
    },
  });
  if (!row.githubRepositoryId || !row.installation)
    throw new Error("runtime proof repository invalid");
  const repository = {
    workspaceId: row.workspaceId,
    repositoryId: row.id,
    githubRepositoryId: row.githubRepositoryId.toString(),
    githubInstallationId: row.installation.githubInstallationId.toString(),
    fullName: row.fullName,
    owner: row.owner,
    selected: true,
    installationStatus: row.installation.status,
  } as const;
  const installer = {
    url: "https://reviewrouter.invalid/seed-codex-rotating-auth.sh",
    version: "runtime-proof-v1",
    sha256: "e".repeat(64),
  };
  const initialRecoveryRequestId = "recovery:runtime-proof-initial";
  const initialRecovery = await recoverCodexRotatingSetup(
    {
      workspaceId: "ws-proof",
      repositoryId: "repo-7",
      githubRepositoryId: "900007",
      recoveryRequestId: initialRecoveryRequestId,
      actor: "runtime-proof",
      acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
      now,
    },
    {
      recovery: new PrismaCodexRotatingSetupRecovery(
        prisma,
        databaseRecoveryWitnessW1,
      ),
    },
  );
  await issueCodexRotatingSetupCommand({
    prisma,
    workspaceId: "ws-proof",
    repositoryId: "repo-7",
    repositoryFullName: "local/proof-7",
    githubRepositoryId: "900007",
    installer,
    databaseRecoveryWitness: databaseRecoveryWitnessW1,
    runtimeEnvironment: localProofRuntimeEnvironment,
    installerArguments: ["--force-reseed"],
    recovery: {
      requestId: initialRecoveryRequestId,
      epoch: initialRecovery.recoveryEpoch,
    },
    setupManifestUrl: "https://reviewrouter.invalid/setup-manifest",
    now,
  });
  const initialManifest = await prisma.codexOAuthSetupManifest.findFirstOrThrow(
    {
      where: { providerInstanceRowId: providerRowId, status: "issued" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { setupNonce: true },
    },
  );
  const initialFetched = await resolveCodexRotatingSetupManifestForNonce({
    prisma,
    setupNonce: initialManifest.setupNonce,
    databaseRecoveryWitness: databaseRecoveryWitnessW1,
    runtimeEnvironment: localProofRuntimeEnvironment,
    now,
  });
  const initialManifestPayload = codexRotatingSetupManifestSchema.parse(
    JSON.parse(
      Buffer.from(initialFetched.manifestBase64, "base64").toString("utf8"),
    ),
  );
  const initialSetupLedger = new PrismaCodexRotatingSetupPayloadClaim(
    prisma,
    databaseRecoveryWitnessW1,
    undefined,
    localProofRuntimeEnvironment,
  );
  const initialClaim = await initialSetupLedger.claim({
    payloadVersion: 2,
    canonicalizationVersion: 1,
    operationId: "operation:runtime-proof-initial",
    repositoryId: "900007",
    providerInstanceId,
    setupNonce: initialManifest.setupNonce,
    manifestDigest: createHash("sha256")
      .update(JSON.stringify(initialManifestPayload), "utf8")
      .digest("hex"),
    recoveryEpoch: initialFetched.recoveryEpoch,
    generationHash: "restored-hash-1",
    accountIdentityHash,
    accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
    authByteSize: 128,
    installerVersion: initialManifestPayload.installer.version,
    installerDigest: initialManifestPayload.installer.sha256,
  });
  const initialDispatch = await initialSetupLedger.authorizeDispatch({
    claimId: initialClaim.claimId,
    idempotencyKey: "dispatch:runtime-proof-initial",
  });
  await initialSetupLedger.recordDispatchOutcome({
    claimId: initialClaim.claimId,
    attemptId: initialDispatch.attemptId,
    outcome: "definite_success",
    responseCode: 204,
  });
  await initialSetupLedger.activate({
    claimId: initialClaim.claimId,
    attemptId: initialDispatch.attemptId,
    repositoryId: "900007",
    namespaceId: initialDispatch.namespaceId,
    namespaceEpoch: initialDispatch.namespaceEpoch,
    secretName: initialDispatch.secretName,
    workflowPath: ".github/workflows/reviewrouter-codex.yml",
    workflowSourceCommitSha: "1".repeat(40),
    workflowSourceBlobSha: "1".repeat(40),
    workflowSourceSha256: "1".repeat(64),
    workflowSemanticSha256: "1".repeat(64),
    sourceTrust: "trusted_default_branch_revision",
  });
  const activeA = createVersionedProviderSecretNamespace({
    scope: { repositoryId: "900007", providerInstanceId },
    namespaceId: initialDispatch.namespaceId,
    epoch: BigInt(initialDispatch.namespaceEpoch),
    name: initialDispatch.secretName,
  });
  let ledger = new PrismaCodexRotatingOAuthRepository(prisma, {
    actionOwnerRepo: "777genius/review-router",
    databaseRecoveryWitness: databaseRecoveryWitnessW1,
  });
  const run = async (
    runId: string,
    restored: string,
    latest: string,
    key: string,
  ) => {
    const lease = await ledger.acquirePrelease({
      repository,
      providerInstanceId,
      githubRunId: runId,
      githubRunAttempt: "1",
      now,
      newWorkAdmissionBarrier: { assertAdmitted: () => undefined },
    });
    if (lease.status !== "preleased")
      throw new Error("runtime proof prelease conflict");
    const finalized = await ledger.finalizeLease({
      leaseId: lease.leaseId,
      providerInstanceId,
      restoredGenerationHash: restored,
      now,
    });
    if (finalized.status !== "finalized")
      throw new Error("runtime proof stale secret");
    await ledger.preflightWriteback({
      leaseId: lease.leaseId,
      providerInstanceId,
      githubKeyId: "github-key",
      now,
    });
    return ledger.prepareVersionedWriteback({
      request: {
        protocolVersion: 1,
        leaseId: lease.leaseId,
        providerInstanceId,
        generation: finalized.nextGeneration,
        latestGenerationHash: latest,
        accountIdentityHash,
        accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
        encryptedValue: Buffer.from(`ciphertext:${runId}`).toString("base64"),
        keyId: "github-key",
        idempotencyKey: key,
      },
      encryptedPayloadDigest: createHash("sha256").update(runId).digest("hex"),
      now,
    });
  };

  const rotatedRuntime = new PrismaCodexRotatingOAuthRepository(prisma, {
    actionOwnerRepo: "777genius/review-router",
    databaseRecoveryWitness: databaseRecoveryWitnessW2,
  });
  const providerBeforeRejectedPrelease =
    await prisma.codexOAuthProviderInstance.findUniqueOrThrow({
      where: { id: providerRowId },
      select: {
        state: true,
        mutationEpoch: true,
        mutationOwner: true,
        mutationOwnerId: true,
        activeLeaseId: true,
        updatedAt: true,
      },
    });
  const leaseCountBeforeRejectedPrelease = await prisma.codexOAuthLease.count({
    where: { providerInstanceRowId: providerRowId },
  });
  if (providerBeforeRejectedPrelease.state !== "active") {
    throw new Error("W1 provider was not healthy before witness proof");
  }
  let rejectedPreleaseError: unknown;
  try {
    await rotatedRuntime.acquirePrelease({
      repository,
      providerInstanceId,
      githubRunId: "runtime-proof-w2-before-recovery",
      githubRunAttempt: "1",
      now,
      newWorkAdmissionBarrier: { assertAdmitted: () => undefined },
    });
  } catch (error) {
    rejectedPreleaseError = error;
  }
  if (
    !(rejectedPreleaseError instanceof Error) ||
    rejectedPreleaseError.message !==
      "codex_rotating_database_recovery_witness_mismatch"
  ) {
    throw new Error(
      "healthy W1 provider did not reject W2 runtime prelease at the witness boundary",
    );
  }
  const providerAfterRejectedPrelease =
    await prisma.codexOAuthProviderInstance.findUniqueOrThrow({
      where: { id: providerRowId },
      select: {
        state: true,
        mutationEpoch: true,
        mutationOwner: true,
        mutationOwnerId: true,
        activeLeaseId: true,
        updatedAt: true,
      },
    });
  const leaseCountAfterRejectedPrelease = await prisma.codexOAuthLease.count({
    where: { providerInstanceRowId: providerRowId },
  });
  if (
    providerAfterRejectedPrelease.state !==
      providerBeforeRejectedPrelease.state ||
    providerAfterRejectedPrelease.mutationEpoch !==
      providerBeforeRejectedPrelease.mutationEpoch ||
    providerAfterRejectedPrelease.mutationOwner !==
      providerBeforeRejectedPrelease.mutationOwner ||
    providerAfterRejectedPrelease.mutationOwnerId !==
      providerBeforeRejectedPrelease.mutationOwnerId ||
    providerAfterRejectedPrelease.activeLeaseId !==
      providerBeforeRejectedPrelease.activeLeaseId ||
    providerAfterRejectedPrelease.updatedAt.getTime() !==
      providerBeforeRejectedPrelease.updatedAt.getTime() ||
    leaseCountAfterRejectedPrelease !== leaseCountBeforeRejectedPrelease
  ) {
    throw new Error("rejected W2 prelease advanced provider or lease state");
  }

  const definite = await run(
    "runtime-proof-definite",
    "restored-hash-1",
    "latest-hash-2",
    "proof:definite",
  );
  if (definite.status !== "ready")
    throw new Error("runtime proof claim missing");
  let missingProviderEvidenceRejected = false;
  try {
    await prisma.$executeRaw`
      UPDATE "CodexOAuthWritebackIntent"
      SET "status" = 'completed', "completedAt" = ${now}, "updatedAt" = ${now}
      WHERE "id" = ${definite.intentId}
    `;
  } catch {
    missingProviderEvidenceRejected = true;
  }
  if (!missingProviderEvidenceRejected) {
    throw new Error("raw pending completion fabricated terminal evidence");
  }
  await ledger.confirmVersionedProviderWrite({
    intentId: definite.intentId,
    attemptId: definite.attemptId,
    executorOwner: definite.executorOwner,
    statusCode: 204,
    now,
  });
  let prematureActivationEvidenceRejected = false;
  try {
    await prisma.$executeRaw`
      UPDATE "CodexOAuthWritebackIntent"
      SET "status" = 'completed', "completedAt" = ${now}, "updatedAt" = ${now}
      WHERE "id" = ${definite.intentId}
    `;
  } catch {
    prematureActivationEvidenceRejected = true;
  }
  if (!prematureActivationEvidenceRejected) {
    throw new Error("raw completion bypassed the activation evidence chain");
  }
  await ledger.activateVersionedWriteback({
    intentId: definite.intentId,
    attemptId: definite.attemptId,
    executorOwner: definite.executorOwner,
    attestation: attestationFor(definite.namespace, "2"),
    now,
  });
  const activated = await prisma.codexOAuthProviderInstance.findUniqueOrThrow({
    where: { id: providerRowId },
    select: {
      activeSecretNamespaceId: true,
      mutationOwner: true,
      latestGenerationHash: true,
    },
  });
  if (
    activated.activeSecretNamespaceId !== definite.namespace.namespaceId ||
    activated.mutationOwner !== null ||
    activated.latestGenerationHash !== "latest-hash-2"
  )
    throw new Error("runtime proof activation failed");
  const retiredA = await prisma.codexOAuthSecretNamespace.findUniqueOrThrow({
    where: { id: activeA.namespaceId },
    select: { status: true, permanentlyRetired: true },
  });
  if (retiredA.status !== "retired_superseded" || !retiredA.permanentlyRetired)
    throw new Error("runtime proof prior namespace not permanently superseded");

  const completedIntent =
    await prisma.codexOAuthWritebackIntent.findUniqueOrThrow({
      where: { id: definite.intentId },
    });
  const replayRequest = {
    protocolVersion: 1 as const,
    leaseId: completedIntent.leaseId,
    providerInstanceId,
    generation: completedIntent.generation,
    latestGenerationHash: completedIntent.latestGenerationHash,
    accountIdentityHash,
    accountIdentityAlgorithm: "provider_issuer_subject_account_v1" as const,
    encryptedValue: Buffer.from("completed-replay-proof").toString("base64"),
    keyId: completedIntent.keyId,
    idempotencyKey: completedIntent.idempotencyKey,
  };
  const matchingReplay = await ledger.prepareVersionedWriteback({
    request: replayRequest,
    encryptedPayloadDigest: completedIntent.encryptedPayloadDigest,
    now,
  });
  if (matchingReplay.status !== "idempotent_replay") {
    throw new Error("completed exact-digest replay was not idempotent");
  }
  const conflictingReplay = await ledger.prepareVersionedWriteback({
    request: replayRequest,
    encryptedPayloadDigest: createHash("sha256")
      .update("different-completed-payload")
      .digest("hex"),
    now,
  });
  if (conflictingReplay.status !== "writeback_idempotency_conflict") {
    throw new Error("completed different-digest replay was accepted");
  }

  const unchanged = await run(
    "runtime-proof-unchanged",
    "latest-hash-2",
    "latest-hash-2",
    "proof:unchanged",
  );
  if (unchanged.status !== "unchanged_generation") {
    throw new Error("unchanged generation did not complete by positive proof");
  }
  const unchangedIntent =
    await prisma.codexOAuthWritebackIntent.findFirstOrThrow({
      where: { idempotencyKey: "proof:unchanged" },
      select: {
        status: true,
        dispatchAttemptId: true,
        secretNamespaceId: true,
        safeErrorCode: true,
        completedAt: true,
      },
    });
  if (
    unchangedIntent.status !== "completed" ||
    unchangedIntent.dispatchAttemptId !== null ||
    unchangedIntent.secretNamespaceId !== null ||
    unchangedIntent.safeErrorCode !==
      "unchanged_generation_positive_proof_v1" ||
    !unchangedIntent.completedAt
  ) {
    throw new Error("unchanged generation relational no-op evidence missing");
  }

  const ambiguous = await run(
    "runtime-proof-ambiguous",
    "latest-hash-2",
    "latest-hash-3",
    "proof:ambiguous",
  );
  if (ambiguous.status !== "ready")
    throw new Error("runtime proof ambiguous claim missing");
  const authorizedIntent =
    await prisma.codexOAuthWritebackIntent.findUniqueOrThrow({
      where: { id: ambiguous.intentId },
    });
  const authorizedRestart = await ledger.prepareVersionedWriteback({
    request: {
      protocolVersion: 1,
      leaseId: authorizedIntent.leaseId,
      providerInstanceId,
      generation: authorizedIntent.generation,
      latestGenerationHash: authorizedIntent.latestGenerationHash,
      accountIdentityHash,
      accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
      encryptedValue: Buffer.from(
        "ciphertext:runtime-proof-ambiguous",
      ).toString("base64"),
      keyId: authorizedIntent.keyId,
      idempotencyKey: authorizedIntent.idempotencyKey,
    },
    encryptedPayloadDigest: authorizedIntent.encryptedPayloadDigest,
    now,
  });
  if (authorizedRestart.status !== "in_progress") {
    throw new Error(
      "live dispatch-authorized duplicate did not remain in progress",
    );
  }
  const expiredRestart = await ledger.prepareVersionedWriteback({
    request: {
      protocolVersion: 1,
      leaseId: authorizedIntent.leaseId,
      providerInstanceId,
      generation: authorizedIntent.generation,
      latestGenerationHash: authorizedIntent.latestGenerationHash,
      accountIdentityHash,
      accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
      encryptedValue: Buffer.from(
        "ciphertext:runtime-proof-ambiguous",
      ).toString("base64"),
      keyId: authorizedIntent.keyId,
      idempotencyKey: authorizedIntent.idempotencyKey,
    },
    encryptedPayloadDigest: authorizedIntent.encryptedPayloadDigest,
    now: new Date(authorizedIntent.executorLeaseExpiresAt!.getTime() + 1),
  });
  if (expiredRestart.status !== "writeback_recovery_required") {
    throw new Error("expired dispatch executor was not recovered");
  }
  await ledger
    .activateVersionedWriteback({
      intentId: ambiguous.intentId,
      attemptId: ambiguous.attemptId,
      executorOwner: ambiguous.executorOwner,
      attestation: attestationFor(ambiguous.namespace, "3"),
      now,
    })
    .then(
      () => {
        throw new Error("retired namespace activated");
      },
      () => undefined,
    );
  const tombstone = await prisma.codexOAuthSecretNamespace.findUniqueOrThrow({
    where: { id: ambiguous.namespace.namespaceId },
    select: { status: true, permanentlyRetired: true },
  });
  if (tombstone.status !== "retired_ambiguous" || !tombstone.permanentlyRetired)
    throw new Error("runtime proof ambiguous namespace not tombstoned");

  // The ambiguous runtime name can only be superseded by a distinct operator
  // recovery decision. That decision remains linked to the unknown-outcome
  // evidence while the setup ledger allocates the next global namespace epoch.
  const recoveryRequestId = "recovery:runtime-proof-ambiguous";
  const recoveryNow = new Date(now.getTime() + 1_000);
  const recovery = await recoverCodexRotatingSetup(
    {
      workspaceId: "ws-proof",
      repositoryId: "repo-7",
      githubRepositoryId: "900007",
      recoveryRequestId,
      actor: "runtime-proof",
      acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
      now: recoveryNow,
    },
    {
      recovery: new PrismaCodexRotatingSetupRecovery(
        prisma,
        databaseRecoveryWitnessW2,
      ),
    },
  );
  await issueCodexRotatingSetupCommand({
    prisma,
    workspaceId: "ws-proof",
    repositoryId: "repo-7",
    repositoryFullName: "local/proof-7",
    githubRepositoryId: "900007",
    installer,
    databaseRecoveryWitness: databaseRecoveryWitnessW2,
    runtimeEnvironment: localProofRuntimeEnvironment,
    installerArguments: ["--force-reseed"],
    recovery: {
      requestId: recoveryRequestId,
      epoch: recovery.recoveryEpoch,
    },
    setupManifestUrl: "https://reviewrouter.invalid/setup-manifest",
    now: recoveryNow,
  });
  const recoveryManifest =
    await prisma.codexOAuthSetupManifest.findFirstOrThrow({
      where: { providerInstanceRowId: providerRowId, status: "issued" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { setupNonce: true },
    });
  const fetched = await resolveCodexRotatingSetupManifestForNonce({
    prisma,
    setupNonce: recoveryManifest.setupNonce,
    databaseRecoveryWitness: databaseRecoveryWitnessW2,
    runtimeEnvironment: localProofRuntimeEnvironment,
    now: recoveryNow,
  });
  const manifest = codexRotatingSetupManifestSchema.parse(
    JSON.parse(Buffer.from(fetched.manifestBase64, "base64").toString("utf8")),
  );
  if (!manifest.repositoryId) {
    throw new Error("runtime proof recovery manifest repository missing");
  }
  const setupLedger = new PrismaCodexRotatingSetupPayloadClaim(
    prisma,
    databaseRecoveryWitnessW2,
    undefined,
    localProofRuntimeEnvironment,
  );
  const prepared = await setupLedger.claim({
    payloadVersion: 2,
    canonicalizationVersion: 1,
    operationId: "operation:runtime-proof-recovery",
    repositoryId: manifest.repositoryId,
    providerInstanceId: manifest.providerInstanceId,
    setupNonce: recoveryManifest.setupNonce,
    manifestDigest: createHash("sha256")
      .update(JSON.stringify(manifest), "utf8")
      .digest("hex"),
    recoveryEpoch: fetched.recoveryEpoch,
    generationHash: "h".repeat(43),
    accountIdentityHash,
    accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
    authByteSize: 128,
    installerVersion: manifest.installer.version,
    installerDigest: manifest.installer.sha256,
  });
  const replacement = await setupLedger.authorizeDispatch({
    claimId: prepared.claimId,
    idempotencyKey: "dispatch:runtime-proof-recovery",
  });
  if (
    BigInt(replacement.namespaceEpoch) !== ambiguous.namespace.epoch + 1n ||
    replacement.secretName === ambiguous.namespace.name
  ) {
    throw new Error("runtime proof recovery reused an ambiguous namespace");
  }
  await setupLedger.recordDispatchOutcome({
    claimId: prepared.claimId,
    attemptId: replacement.attemptId,
    outcome: "definite_success",
    responseCode: 204,
  });
  await setupLedger.activate({
    claimId: prepared.claimId,
    attemptId: replacement.attemptId,
    repositoryId: "900007",
    namespaceId: replacement.namespaceId,
    namespaceEpoch: replacement.namespaceEpoch,
    secretName: replacement.secretName,
    workflowPath: ".github/workflows/reviewrouter-codex.yml",
    workflowSourceCommitSha: "4".repeat(40),
    workflowSourceBlobSha: "4".repeat(40),
    workflowSourceSha256: "4".repeat(64),
    workflowSemanticSha256: "4".repeat(64),
    sourceTrust: "trusted_default_branch_revision",
  });
  const recovered = await prisma.codexOAuthWritebackIntent.findUniqueOrThrow({
    where: { id: ambiguous.intentId },
    select: {
      status: true,
      recoveryRequestRowId: true,
      recoveryResolvedAt: true,
    },
  });
  const recoveredProvider =
    await prisma.codexOAuthProviderInstance.findUniqueOrThrow({
      where: { id: providerRowId },
      select: {
        activeSecretNamespaceId: true,
        mutationOwner: true,
        state: true,
      },
    });
  if (
    recovered.status !== "remote_outcome_unknown" ||
    !recovered.recoveryRequestRowId ||
    !recovered.recoveryResolvedAt ||
    recoveredProvider.activeSecretNamespaceId !== replacement.namespaceId ||
    recoveredProvider.mutationOwner !== null ||
    recoveredProvider.state !== "active"
  ) {
    throw new Error("runtime proof recovery activation failed");
  }
  const witnessEvidence = await prisma.codexOAuthSecretNamespace.findMany({
    where: {
      id: { in: [activeA.namespaceId, replacement.namespaceId] },
    },
    select: { id: true, databaseRecoveryWitness: true },
  });
  const witnessById = new Map(
    witnessEvidence.map((entry) => [entry.id, entry.databaseRecoveryWitness]),
  );
  if (
    witnessById.get(activeA.namespaceId) !==
      createHash("sha256").update(databaseRecoveryWitnessW1).digest("hex") ||
    witnessById.get(replacement.namespaceId) !==
      createHash("sha256").update(databaseRecoveryWitnessW2).digest("hex")
  ) {
    throw new Error("W1 evidence was rewritten or W2 namespace was misbound");
  }
  ledger = rotatedRuntime;

  const confirmedRestart = await run(
    "runtime-proof-confirmed-restart",
    "h".repeat(43),
    "latest-hash-4",
    "proof:confirmed-restart",
  );
  if (confirmedRestart.status !== "ready") {
    throw new Error("runtime confirmed-restart claim missing");
  }
  await ledger.confirmVersionedProviderWrite({
    intentId: confirmedRestart.intentId,
    attemptId: confirmedRestart.attemptId,
    executorOwner: confirmedRestart.executorOwner,
    statusCode: 204,
    now,
  });
  const confirmedIntent =
    await prisma.codexOAuthWritebackIntent.findUniqueOrThrow({
      where: { id: confirmedRestart.intentId },
      include: { lease: { select: { expiresAt: true } } },
    });
  await ledger
    .activateVersionedWriteback({
      intentId: confirmedRestart.intentId,
      attemptId: confirmedRestart.attemptId,
      executorOwner: confirmedRestart.executorOwner,
      attestation: attestationFor(confirmedRestart.namespace, "5"),
      now: confirmedIntent.lease.expiresAt,
    })
    .then(
      () => {
        throw new Error("deadline-crossing activation succeeded");
      },
      () => undefined,
    );
  const confirmedRetry = await ledger.prepareVersionedWriteback({
    request: {
      protocolVersion: 1,
      leaseId: confirmedIntent.leaseId,
      providerInstanceId,
      generation: confirmedIntent.generation,
      latestGenerationHash: confirmedIntent.latestGenerationHash,
      accountIdentityHash,
      accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
      encryptedValue: Buffer.from("randomized-restart-ciphertext").toString(
        "base64",
      ),
      keyId: confirmedIntent.keyId,
      idempotencyKey: confirmedIntent.idempotencyKey,
    },
    encryptedPayloadDigest: confirmedIntent.encryptedPayloadDigest,
    now: new Date(confirmedIntent.executorLeaseExpiresAt!.getTime() + 1),
  });
  if (confirmedRetry.status !== "writeback_recovery_required") {
    throw new Error("confirmed response restart did not fail closed");
  }
  const confirmedTombstone =
    await prisma.codexOAuthSecretNamespace.findUniqueOrThrow({
      where: { id: confirmedRestart.namespace.namespaceId },
      select: { status: true, permanentlyRetired: true },
    });
  if (
    confirmedTombstone.status !== "retired_ambiguous" ||
    !confirmedTombstone.permanentlyRetired
  ) {
    throw new Error("confirmed response restart reused its namespace");
  }
} finally {
  await prisma.$disconnect();
}
