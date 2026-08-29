import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createPrismaClient,
  type PrismaClient,
} from "../packages/platform/db/src/index";
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

const providerAdminDatabaseUrl = requiredUrl(
  "REVIEW_ROUTER_PRISMA_EVIDENCE_PROVIDER_ADMIN_DATABASE_URL",
);
const apiDatabaseUrl = requiredUrl(
  "REVIEW_ROUTER_PRISMA_EVIDENCE_API_DATABASE_URL",
);
const webDatabaseUrl = requiredUrl(
  "REVIEW_ROUTER_PRISMA_EVIDENCE_WEB_DATABASE_URL",
);
const effectAuthorityDatabaseUrl = requiredUrl(
  "REVIEW_ROUTER_PRISMA_EVIDENCE_EFFECT_AUTHORITY_DATABASE_URL",
);
const adminPrisma = createPrismaClient({
  databaseUrl: providerAdminDatabaseUrl,
});
const apiPrisma = createPrismaClient({
  databaseUrl: apiDatabaseUrl,
  poolMax: 1,
});
const webPrisma = createPrismaClient({
  databaseUrl: webDatabaseUrl,
  poolMax: 1,
});
const effectAuthorityPrisma = createPrismaClient({
  databaseUrl: effectAuthorityDatabaseUrl,
  poolMax: 1,
});
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
    workflowSchemaVersion: 5,
    sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
    secretNamespace: namespace,
  });

function requiredUrl(name: string): string {
  const file = process.env[`${name}_FILE`]?.trim();
  const value = file
    ? readFileSync(file, "utf8").trim()
    : process.env[name]?.trim();
  if (!value)
    throw new Error(`runtime versioned writeback proof URL required:${name}`);
  return value;
}

async function readDatabaseClock(client: PrismaClient): Promise<Date> {
  const rows = await client.$queryRaw<readonly { epochMs: bigint }[]>`
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "epochMs"
  `;
  const epochMs = rows[0]?.epochMs;
  const numericEpochMs = epochMs === undefined ? Number.NaN : Number(epochMs);
  if (!Number.isSafeInteger(numericEpochMs)) {
    throw new Error("runtime proof database clock invalid");
  }
  return new Date(numericEpochMs);
}

async function observeDatabaseSession(
  client: PrismaClient,
  expectedSessionUser: string,
) {
  const rows = await client.$queryRaw<
    readonly {
      sessionUser: string;
      currentUser: string;
      backendPid: number;
      databaseName: string;
    }[]
  >`
    SELECT session_user AS "sessionUser", current_user AS "currentUser",
      pg_backend_pid() AS "backendPid", current_database() AS "databaseName"
  `;
  const session = rows[0];
  if (
    !session ||
    session.sessionUser !== expectedSessionUser ||
    session.currentUser !== expectedSessionUser
  ) {
    throw new Error(
      `runtime proof database identity mismatch:${expectedSessionUser}`,
    );
  }
  return session;
}

async function assertActiveApplications(
  admin: PrismaClient,
  expectedApplications: readonly string[],
): Promise<void> {
  const rows = await admin.$queryRaw<
    readonly { applicationName: string; count: bigint }[]
  >`
    SELECT application_name AS "applicationName", count(*)::bigint AS count
    FROM pg_stat_activity
    WHERE datname = current_database()
    GROUP BY application_name
  `;
  const counts = new Map(
    rows.map((row) => [row.applicationName, Number(row.count)]),
  );
  for (const applicationName of expectedApplications) {
    if (counts.get(applicationName) !== 1) {
      throw new Error(
        `runtime proof application backend mismatch:${applicationName}`,
      );
    }
  }
}

function fixedTransactionClock(now: Date) {
  return { now: async () => new Date(now) };
}

function nullableDatesExactlyEqual(left: Date | null, right: Date | null) {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}

async function expectSignatureReplayRejected(
  client: PrismaClient,
  claim: Readonly<{ intentId: string; executorOwner: string }>,
  signature: string,
): Promise<void> {
  let replayError: unknown;
  try {
    await client.$executeRaw`
      SELECT "codex_oauth_authorize_runtime_confirmation"(
        ${claim.intentId}, ${claim.executorOwner}, 204, ${signature}
      )
    `;
  } catch (error) {
    replayError = error;
  }
  if (
    !(replayError instanceof Error) ||
    !replayError.message.includes(
      "codex_oauth_database_authority_signature_invalid",
    )
  ) {
    throw new Error("runtime authority signature replay was accepted");
  }
}

async function assertConsumedReceipt(
  admin: PrismaClient,
  input: {
    ownerId: string;
    effect: string;
    effectCode: number;
    databaseRole: string;
  },
): Promise<void> {
  const receipts = await admin.$queryRaw<
    readonly { databaseRole: string; consumedAt: Date | null }[]
  >`
    SELECT "databaseRole", "consumedAt"
    FROM public."CodexOAuthDatabaseAuthorityReceipt"
    WHERE "ownerId" = ${input.ownerId}
      AND "effect" = ${input.effect}
      AND "effectCode" = ${input.effectCode}
  `;
  if (
    receipts.length !== 1 ||
    receipts[0]?.databaseRole !== input.databaseRole ||
    !receipts[0].consumedAt
  ) {
    throw new Error(`runtime proof authority receipt mismatch:${input.effect}`);
  }
}

try {
  const sessions = await Promise.all([
    observeDatabaseSession(apiPrisma, "reviewrouter_api"),
    observeDatabaseSession(webPrisma, "reviewrouter_web"),
    observeDatabaseSession(
      effectAuthorityPrisma,
      "reviewrouter_codex_effect_authority",
    ),
  ]);
  const [apiSession, webSession, effectAuthoritySession] = sessions;
  if (
    new Set(sessions.map((session) => session.databaseName)).size !== 1 ||
    new Set(sessions.map((session) => session.backendPid)).size !== 3
  ) {
    throw new Error("runtime proof service clients were not backend-isolated");
  }
  if (
    apiSession.sessionUser !== "reviewrouter_api" ||
    webSession.sessionUser !== "reviewrouter_web" ||
    effectAuthoritySession.sessionUser !== "reviewrouter_codex_effect_authority"
  ) {
    throw new Error("runtime proof service role mismatch");
  }
  await assertActiveApplications(adminPrisma, [
    "rr-rehearsal-api",
    "rr-rehearsal-web",
    "rr-rehearsal-effect-authority",
  ]);
  let now = await readDatabaseClock(webPrisma);
  await adminPrisma.gitHubInstallation.create({
    data: {
      id: "runtime-proof-installation",
      workspaceId: "ws-proof",
      githubInstallationId: 990007n,
      accountLogin: "local",
      accountType: "Organization",
      repositorySelection: "selected",
    },
  });
  await adminPrisma.repositoryConnection.update({
    where: { id: "repo-7" },
    data: { installationId: "runtime-proof-installation" },
  });
  const row = await adminPrisma.repositoryConnection.findUniqueOrThrow({
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
        webPrisma,
        databaseRecoveryWitnessW1,
      ),
    },
  );
  now = await readDatabaseClock(webPrisma);
  await issueCodexRotatingSetupCommand({
    prisma: webPrisma,
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
  now = await readDatabaseClock(webPrisma);
  const initialManifest =
    await adminPrisma.codexOAuthSetupManifest.findFirstOrThrow({
      where: { providerInstanceRowId: providerRowId, status: "issued" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { setupNonce: true },
    });
  const initialFetched = await resolveCodexRotatingSetupManifestForNonce({
    prisma: webPrisma,
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
    webPrisma,
    databaseRecoveryWitnessW1,
    undefined,
    localProofRuntimeEnvironment,
    effectAuthorityPrisma,
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
  await assertConsumedReceipt(adminPrisma, {
    ownerId: initialDispatch.attemptId,
    effect: "setup_confirmation",
    effectCode: 204,
    databaseRole: "reviewrouter_web",
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
    workflowSchemaVersion: 5,
  });
  const activeA = createVersionedProviderSecretNamespace({
    scope: { repositoryId: "900007", providerInstanceId },
    namespaceId: initialDispatch.namespaceId,
    epoch: BigInt(initialDispatch.namespaceEpoch),
    name: initialDispatch.secretName,
  });
  let ledger = new PrismaCodexRotatingOAuthRepository(apiPrisma, {
    actionOwnerRepo: "777genius/review-router",
    databaseRecoveryWitness: databaseRecoveryWitnessW1,
    databaseEffectAuthority: effectAuthorityPrisma,
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
      newWorkAdmissionBarrier: { assertAdmitted: () => undefined },
    });
    if (lease.status !== "preleased")
      throw new Error("runtime proof prelease conflict");
    const finalized = await ledger.finalizeLease({
      leaseId: lease.leaseId,
      providerInstanceId,
      restoredGenerationHash: restored,
    });
    if (finalized.status !== "finalized")
      throw new Error("runtime proof stale secret");
    await ledger.preflightWriteback({
      leaseId: lease.leaseId,
      providerInstanceId,
      githubKeyId: "github-key",
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
    });
  };

  const rotatedRuntime = new PrismaCodexRotatingOAuthRepository(apiPrisma, {
    actionOwnerRepo: "777genius/review-router",
    databaseRecoveryWitness: databaseRecoveryWitnessW2,
    databaseEffectAuthority: effectAuthorityPrisma,
  });
  const providerBeforeRejectedPrelease =
    await adminPrisma.codexOAuthProviderInstance.findUniqueOrThrow({
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
  const leaseCountBeforeRejectedPrelease =
    await adminPrisma.codexOAuthLease.count({
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
    await adminPrisma.codexOAuthProviderInstance.findUniqueOrThrow({
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
  const leaseCountAfterRejectedPrelease =
    await adminPrisma.codexOAuthLease.count({
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
    now = await readDatabaseClock(apiPrisma);
    await apiPrisma.$executeRaw`
      UPDATE "CodexOAuthWritebackIntent"
      SET "status" = 'completed', "completedAt" = ${now}, "updatedAt" = ${now}
      WHERE "id" = ${definite.intentId}
    `;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("codex_oauth_database_authority_receipt_required")
    ) {
      throw error;
    }
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
  });
  await assertConsumedReceipt(adminPrisma, {
    ownerId: definite.intentId,
    effect: "runtime_confirmation",
    effectCode: 204,
    databaseRole: "reviewrouter_api",
  });
  let prematureActivationEvidenceRejected = false;
  try {
    now = await readDatabaseClock(apiPrisma);
    await apiPrisma.$executeRaw`
      UPDATE "CodexOAuthWritebackIntent"
      SET "status" = 'completed', "completedAt" = ${now}, "updatedAt" = ${now}
      WHERE "id" = ${definite.intentId}
    `;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("codex_oauth_database_authority_receipt_required")
    ) {
      throw error;
    }
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
  });
  await assertConsumedReceipt(adminPrisma, {
    ownerId: definite.intentId,
    effect: "runtime_completion",
    effectCode: 0,
    databaseRole: "reviewrouter_api",
  });
  const activated =
    await adminPrisma.codexOAuthProviderInstance.findUniqueOrThrow({
      where: { id: providerRowId },
      select: {
        activeSecretNamespaceId: true,
        mutationOwner: true,
        latestGenerationHash: true,
      },
    });
  if (
    activated.activeSecretNamespaceId !== definite.namespace.namespaceId ||
    definite.namespace.namespaceId !== activeA.namespaceId ||
    activated.mutationOwner !== null ||
    activated.latestGenerationHash !== "latest-hash-2"
  )
    throw new Error("runtime proof activation failed");
  const retainedA =
    await adminPrisma.codexOAuthSecretNamespace.findUniqueOrThrow({
      where: { id: activeA.namespaceId },
      select: { status: true, permanentlyRetired: true },
    });
  if (retainedA.status !== "active" || retainedA.permanentlyRetired)
    throw new Error("runtime proof did not retain the active namespace");

  const completedIntent =
    await adminPrisma.codexOAuthWritebackIntent.findUniqueOrThrow({
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
  });
  if (matchingReplay.status !== "idempotent_replay") {
    throw new Error("completed exact-digest replay was not idempotent");
  }
  const conflictingReplay = await ledger.prepareVersionedWriteback({
    request: replayRequest,
    encryptedPayloadDigest: createHash("sha256")
      .update("different-completed-payload")
      .digest("hex"),
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
    await adminPrisma.codexOAuthWritebackIntent.findFirstOrThrow({
      where: { idempotencyKey: "proof:unchanged" },
      select: {
        id: true,
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
  await assertConsumedReceipt(adminPrisma, {
    ownerId: unchangedIntent.id,
    effect: "runtime_completion",
    effectCode: 0,
    databaseRole: "reviewrouter_api",
  });

  const ambiguous = await run(
    "runtime-proof-ambiguous",
    "latest-hash-2",
    "latest-hash-3",
    "proof:ambiguous",
  );
  if (ambiguous.status !== "ready")
    throw new Error("runtime proof ambiguous claim missing");
  const authorizedIntent =
    await adminPrisma.codexOAuthWritebackIntent.findUniqueOrThrow({
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
  });
  if (authorizedRestart.status !== "in_progress") {
    throw new Error(
      "live dispatch-authorized duplicate did not remain in progress",
    );
  }
  const expiredRestartLedger = new PrismaCodexRotatingOAuthRepository(
    apiPrisma,
    {
      actionOwnerRepo: "777genius/review-router",
      databaseRecoveryWitness: databaseRecoveryWitnessW1,
      databaseEffectAuthority: effectAuthorityPrisma,
      transactionClock: fixedTransactionClock(
        new Date(authorizedIntent.executorLeaseExpiresAt!.getTime() + 1),
      ),
    },
  );
  const expiredRestart = await expiredRestartLedger.prepareVersionedWriteback({
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
    })
    .then(
      () => {
        throw new Error("retired namespace activated");
      },
      () => undefined,
    );
  const retainedAmbiguousNamespace =
    await adminPrisma.codexOAuthSecretNamespace.findUniqueOrThrow({
      where: { id: ambiguous.namespace.namespaceId },
      select: { status: true, permanentlyRetired: true },
    });
  if (
    retainedAmbiguousNamespace.status !== "active" ||
    retainedAmbiguousNamespace.permanentlyRetired
  ) {
    throw new Error("runtime proof ambiguous refresh mutated active namespace");
  }

  // The ambiguous runtime name can only be superseded by a distinct operator
  // recovery decision. That decision remains linked to the unknown-outcome
  // evidence while the setup ledger allocates the next global namespace epoch.
  const recoveryRequestId = "recovery:runtime-proof-ambiguous";
  let recoveryNow = await readDatabaseClock(webPrisma);
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
        webPrisma,
        databaseRecoveryWitnessW2,
      ),
    },
  );
  recoveryNow = await readDatabaseClock(webPrisma);
  await issueCodexRotatingSetupCommand({
    prisma: webPrisma,
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
    await adminPrisma.codexOAuthSetupManifest.findFirstOrThrow({
      where: { providerInstanceRowId: providerRowId, status: "issued" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { setupNonce: true },
    });
  recoveryNow = await readDatabaseClock(webPrisma);
  const fetched = await resolveCodexRotatingSetupManifestForNonce({
    prisma: webPrisma,
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
    webPrisma,
    databaseRecoveryWitnessW2,
    undefined,
    localProofRuntimeEnvironment,
    effectAuthorityPrisma,
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
  await assertConsumedReceipt(adminPrisma, {
    ownerId: replacement.attemptId,
    effect: "setup_confirmation",
    effectCode: 204,
    databaseRole: "reviewrouter_web",
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
    // Preserve one evidence-backed V4 active namespace for the migration's
    // one-shot V4-to-V5 re-attestation proof below.
    workflowSchemaVersion: 4,
  });
  const recovered =
    await adminPrisma.codexOAuthWritebackIntent.findUniqueOrThrow({
      where: { id: ambiguous.intentId },
      select: {
        status: true,
        recoveryRequestRowId: true,
        recoveryResolvedAt: true,
      },
    });
  const recoveredProvider =
    await adminPrisma.codexOAuthProviderInstance.findUniqueOrThrow({
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
  const supersededAmbiguousNamespace =
    await adminPrisma.codexOAuthSecretNamespace.findUniqueOrThrow({
      where: { id: ambiguous.namespace.namespaceId },
      select: { status: true, permanentlyRetired: true },
    });
  if (
    supersededAmbiguousNamespace.status !== "retired_superseded" ||
    !supersededAmbiguousNamespace.permanentlyRetired
  ) {
    throw new Error("runtime proof recovery did not retire prior namespace");
  }
  const witnessEvidence = await adminPrisma.codexOAuthSecretNamespace.findMany({
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

  const rollbackClaim = await run(
    "runtime-proof-rollback",
    "h".repeat(43),
    "latest-hash-rollback",
    "proof:rollback",
  );
  if (rollbackClaim.status !== "ready") {
    throw new Error("runtime rollback claim missing");
  }
  const rollbackBefore =
    await adminPrisma.codexOAuthWritebackIntent.findUniqueOrThrow({
      where: { id: rollbackClaim.intentId },
      select: {
        providerResponseCode: true,
        providerConfirmedAt: true,
        updatedAt: true,
        secretNamespace: {
          select: {
            id: true,
            status: true,
            confirmedAt: true,
            activatedAt: true,
            retiredAt: true,
          },
        },
        providerInstance: {
          select: { mutationEpoch: true, updatedAt: true },
        },
      },
    });
  let capturedRollbackSignature = "";
  try {
    await apiPrisma.$transaction(async (tx) => {
      const challenges = await tx.$queryRaw<readonly { challenge: string }[]>`
        SELECT "codex_oauth_database_authority_challenge"(
          'runtime_confirmation', ${rollbackClaim.intentId}, 204
        ) AS challenge
      `;
      const challenge = challenges[0]?.challenge;
      if (!challenge) throw new Error("runtime rollback challenge missing");
      const signed = await effectAuthorityPrisma.$queryRaw<
        readonly {
          sessionUser: string;
          backendPid: number;
          signature: string;
        }[]
      >`
        SELECT session_user AS "sessionUser", pg_backend_pid() AS "backendPid",
          "codex_oauth_sign_database_authority"(${challenge}) AS signature
      `;
      const signer = signed[0];
      if (
        !signer ||
        signer.sessionUser !== "reviewrouter_codex_effect_authority" ||
        signer.backendPid !== effectAuthoritySession.backendPid
      ) {
        throw new Error("runtime rollback signer identity changed");
      }
      capturedRollbackSignature = signer.signature;
      await tx.$executeRaw`
        SELECT "codex_oauth_authorize_runtime_confirmation"(
          ${rollbackClaim.intentId}, ${rollbackClaim.executorOwner}, 204,
          ${capturedRollbackSignature}
        )
      `;
      await tx.$executeRaw`
        UPDATE "CodexOAuthWritebackIntent"
        SET "safeErrorCode" = 'provider_confirmed_v1',
            "providerResponseCode" = 204,
            "providerConfirmedAt" = clock_timestamp()
        WHERE "id" = ${rollbackClaim.intentId}
      `;
      const consumedAgain = await tx.$queryRaw<
        readonly { consumed: boolean }[]
      >`
        SELECT "codex_oauth_consume_database_authority"(
          'runtime_confirmation', ${rollbackClaim.intentId}, 204
        ) AS consumed
      `;
      if (consumedAgain[0]?.consumed !== false) {
        throw new Error("runtime receipt double consume succeeded");
      }
      throw new Error("runtime_authority_rollback_sentinel");
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "runtime_authority_rollback_sentinel"
    ) {
      throw error;
    }
  }
  const rollbackReceiptCountRows = await adminPrisma.$queryRaw<
    readonly { count: bigint }[]
  >`
    SELECT count(*)::bigint AS count
    FROM public."CodexOAuthDatabaseAuthorityReceipt"
    WHERE "ownerId" = ${rollbackClaim.intentId}
  `;
  const rollbackReceiptCount = rollbackReceiptCountRows[0]?.count;
  const rollbackAfter =
    await adminPrisma.codexOAuthWritebackIntent.findUniqueOrThrow({
      where: { id: rollbackClaim.intentId },
      select: {
        providerResponseCode: true,
        providerConfirmedAt: true,
        updatedAt: true,
        secretNamespace: {
          select: {
            id: true,
            status: true,
            confirmedAt: true,
            activatedAt: true,
            retiredAt: true,
          },
        },
        providerInstance: {
          select: { mutationEpoch: true, updatedAt: true },
        },
      },
    });
  if (
    rollbackReceiptCount !== 0n ||
    rollbackAfter.providerResponseCode !== null ||
    rollbackAfter.providerConfirmedAt !== null ||
    rollbackAfter.updatedAt.getTime() !== rollbackBefore.updatedAt.getTime() ||
    rollbackBefore.secretNamespace === null ||
    rollbackAfter.secretNamespace === null ||
    rollbackAfter.secretNamespace.id !== rollbackBefore.secretNamespace.id ||
    rollbackAfter.secretNamespace.status !==
      rollbackBefore.secretNamespace.status ||
    !nullableDatesExactlyEqual(
      rollbackAfter.secretNamespace.confirmedAt,
      rollbackBefore.secretNamespace.confirmedAt,
    ) ||
    !nullableDatesExactlyEqual(
      rollbackAfter.secretNamespace.activatedAt,
      rollbackBefore.secretNamespace.activatedAt,
    ) ||
    !nullableDatesExactlyEqual(
      rollbackAfter.secretNamespace.retiredAt,
      rollbackBefore.secretNamespace.retiredAt,
    ) ||
    rollbackAfter.providerInstance.mutationEpoch !==
      rollbackBefore.providerInstance.mutationEpoch ||
    rollbackAfter.providerInstance.updatedAt.getTime() !==
      rollbackBefore.providerInstance.updatedAt.getTime()
  ) {
    throw new Error("runtime authorization rollback left poison state");
  }
  await expectSignatureReplayRejected(
    apiPrisma,
    rollbackClaim,
    capturedRollbackSignature,
  );
  const secondApiPrisma = createPrismaClient({
    databaseUrl: apiDatabaseUrl,
    poolMax: 1,
  });
  try {
    const secondApiSession = await observeDatabaseSession(
      secondApiPrisma,
      "reviewrouter_api",
    );
    if (secondApiSession.backendPid === apiSession.backendPid) {
      throw new Error("runtime replay did not use a second API backend");
    }
    await expectSignatureReplayRejected(
      secondApiPrisma,
      rollbackClaim,
      capturedRollbackSignature,
    );
  } finally {
    await secondApiPrisma.$disconnect();
  }
  const laterConsume = await apiPrisma.$queryRaw<
    readonly { consumed: boolean }[]
  >`
    SELECT "codex_oauth_consume_database_authority"(
      'runtime_confirmation', ${rollbackClaim.intentId}, 204
    ) AS consumed
  `;
  if (laterConsume[0]?.consumed !== false) {
    throw new Error("runtime receipt consumed in a later transaction");
  }
  await ledger.confirmVersionedProviderWrite({
    intentId: rollbackClaim.intentId,
    attemptId: rollbackClaim.attemptId,
    executorOwner: rollbackClaim.executorOwner,
    statusCode: 204,
  });
  await ledger.activateVersionedWriteback({
    intentId: rollbackClaim.intentId,
    attemptId: rollbackClaim.attemptId,
    executorOwner: rollbackClaim.executorOwner,
    attestation: attestationFor(rollbackClaim.namespace, "6"),
  });

  const confirmedRestart = await run(
    "runtime-proof-confirmed-restart",
    "latest-hash-rollback",
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
  });
  const confirmedIntent =
    await adminPrisma.codexOAuthWritebackIntent.findUniqueOrThrow({
      where: { id: confirmedRestart.intentId },
      include: { lease: { select: { expiresAt: true } } },
    });
  const equalityBoundaryLedger = new PrismaCodexRotatingOAuthRepository(
    apiPrisma,
    {
      actionOwnerRepo: "777genius/review-router",
      databaseRecoveryWitness: databaseRecoveryWitnessW2,
      databaseEffectAuthority: effectAuthorityPrisma,
      transactionClock: fixedTransactionClock(
        confirmedIntent.executorLeaseExpiresAt!,
      ),
    },
  );
  await equalityBoundaryLedger
    .activateVersionedWriteback({
      intentId: confirmedRestart.intentId,
      attemptId: confirmedRestart.attemptId,
      executorOwner: confirmedRestart.executorOwner,
      attestation: attestationFor(confirmedRestart.namespace, "5"),
    })
    .then(
      () => {
        throw new Error("deadline-crossing activation succeeded");
      },
      () => undefined,
    );
  const confirmedExpiredLedger = new PrismaCodexRotatingOAuthRepository(
    apiPrisma,
    {
      actionOwnerRepo: "777genius/review-router",
      databaseRecoveryWitness: databaseRecoveryWitnessW2,
      databaseEffectAuthority: effectAuthorityPrisma,
      transactionClock: fixedTransactionClock(
        new Date(confirmedIntent.executorLeaseExpiresAt!.getTime() + 1),
      ),
    },
  );
  const confirmedRetry = await confirmedExpiredLedger.prepareVersionedWriteback(
    {
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
    },
  );
  if (confirmedRetry.status !== "writeback_recovery_required") {
    throw new Error("confirmed response restart did not fail closed");
  }
  const confirmedAmbiguousNamespace =
    await adminPrisma.codexOAuthSecretNamespace.findUniqueOrThrow({
      where: { id: confirmedRestart.namespace.namespaceId },
      select: { status: true, permanentlyRetired: true },
    });
  if (
    confirmedAmbiguousNamespace.status !== "active" ||
    confirmedAmbiguousNamespace.permanentlyRetired
  ) {
    throw new Error("confirmed response restart mutated active namespace");
  }
  const unconsumedReceiptCountRows = await adminPrisma.$queryRaw<
    readonly { count: bigint }[]
  >`
    SELECT count(*)::bigint AS count
    FROM public."CodexOAuthDatabaseAuthorityReceipt"
    WHERE "consumedAt" IS NULL
  `;
  if (unconsumedReceiptCountRows[0]?.count !== 0n) {
    throw new Error("runtime proof left an unconsumed authority receipt");
  }
} finally {
  await Promise.all([
    adminPrisma.$disconnect(),
    apiPrisma.$disconnect(),
    webPrisma.$disconnect(),
    effectAuthorityPrisma.$disconnect(),
  ]);
}
