#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Runtime validators below are the trust boundary for observation data. Their
 * compile-time producer contracts live in codex-rotating-rollout-observations.ts.
 * @typedef {import("./codex-rotating-rollout-observations.js").ProductionWriterObservation} ProductionWriterObservation
 * @typedef {import("./codex-rotating-rollout-observations.js").WorkflowRunInventoryObservation} WorkflowRunInventoryObservation
 * @typedef {import("./codex-rotating-rollout-observations.js").CanaryRuntimeObservation} CanaryRuntimeObservation
 */

const checkoutRoot = resolve(import.meta.dirname, "..");
const migrations = [
  {
    id: "000060_codex_oauth_setup_serialization",
    sourceFile:
      "packages/platform/db/prisma/migrations/000060_codex_oauth_setup_serialization/migration.sql",
  },
  {
    id: "000061_codex_oauth_provider_mutation_fence",
    sourceFile:
      "packages/platform/db/prisma/migrations/000061_codex_oauth_provider_mutation_fence/migration.sql",
  },
];
const exactServices = ["api", "web", "worker"];
const exactCases = [
  "legacy-consumed-confirmation-replay",
  "v1-workflow-after-v2-publication",
  "v2-workflow-fence-aware",
];
const exactTriggers = [
  "CodexOAuthLease_identity_fence_guard",
  "CodexOAuthProviderInstance_identity_guard",
  "CodexOAuthProviderInstance_mutation_transition_guard",
  "CodexOAuthSetupManifest_identity_fence_guard",
  "CodexOAuthWritebackIntent_identity_fence_guard",
  "RepositoryConnection_codex_oauth_identity_guard",
];
const exactChecks = [
  "CodexOAuthLease_epoch_check",
  "CodexOAuthProviderInstance_mutation_fence_check",
  "CodexOAuthSetupManifest_epoch_check",
  "CodexOAuthWritebackIntent_epoch_check",
];
const exactIndexes = [
  "CodexOAuthChildIdentityQuarantine_provider_idx",
  "CodexOAuthLease_provider_epoch_idx",
  "CodexOAuthProviderInstance_mutation_owner_idx",
  "CodexOAuthSetupManifest_one_active_provider_key",
  "CodexOAuthSetupManifest_provider_epoch_idx",
  "CodexOAuthWritebackIntent_provider_epoch_idx",
];

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
export function canonicalJson(value) {
  return `${JSON.stringify(sortJson(value))}\n`;
}
export function sha256Utf8(value) {
  return sha256(Buffer.from(value, "utf8"));
}

export function runCodexRotatingRolloutVerifierCli(
  args,
  { stdout = process.stdout, stderr = process.stderr } = {},
) {
  if (!args[0]) {
    stderr.write("usage: verify-codex-rotating-rollout.mjs <evidence.json>\n");
    return 2;
  }
  try {
    const evidencePath = resolve(args[0]);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    const result = verifyCodexRotatingRollout(evidence, {
      evidenceDirectory: resolve(evidencePath, ".."),
    });
    if (!result.ok) {
      for (const failure of result.failures) stderr.write(`FAIL: ${failure}\n`);
      return 1;
    }
    stdout.write(`PASS proof-bundle-sha256=${result.proofBundleSha256}\n`);
    return 0;
  } catch {
    stderr.write(
      "FAIL: rollout evidence or an observed artifact is not readable JSON\n",
    );
    return 1;
  }
}

export function verifyCodexRotatingRollout(evidence, options = {}) {
  const failures = [];
  const need = (condition, message) => {
    if (!condition) failures.push(message);
  };
  need(
    evidence?.version === 2,
    "evidence must use observation-backed version 2",
  );
  need(
    hasExactKeys(evidence, ["artifacts", "version"]),
    "top-level self-reported rollout fields are prohibited",
  );
  need(
    hasExactKeys(evidence?.artifacts, [
      "canaryRuntime",
      "compatibilityProbe",
      "database",
      "deployments",
      "events",
      "workflowRuns",
    ]),
    "all four observed artifacts are required",
  );

  const loaded = {};
  for (const name of [
    "database",
    "deployments",
    "compatibilityProbe",
    "events",
    "canaryRuntime",
    "workflowRuns",
  ]) {
    const descriptor = evidence?.artifacts?.[name];
    need(
      hasExactKeys(
        descriptor,
        name === "compatibilityProbe" || name === "database"
          ? ["path", "sha256", "sourceFile", "sourceFileSha256"]
          : ["path", "sha256"],
      ),
      `${name} artifact descriptor is invalid`,
    );
    const artifact = loadArtifact(descriptor, options);
    need(artifact.digestValid, `${name} artifact digest mismatched`);
    need(artifact.value !== null, `${name} artifact is unreadable`);
    loaded[name] = artifact.value;
  }

  const databaseFacts = verifyDatabase(
    loaded.database,
    evidence?.artifacts?.database,
    need,
    options,
  );
  const deploymentFacts = verifyDeployments(loaded.deployments, need);
  need(
    databaseFacts?.callerCommit === deploymentFacts.commit &&
      databaseFacts?.callerImageDigest === deploymentFacts.imageDigest,
    "release-migration caller is not bound to the deployed immutable release",
  );
  const compatibilityFacts = verifyCompatibility(
    loaded.compatibilityProbe,
    evidence?.artifacts?.compatibilityProbe,
    deploymentFacts,
    need,
    options,
  );
  const workflowFacts = verifyWorkflowRuns(loaded.workflowRuns, need);
  const canaryFacts = verifyCanaryRuntime(
    loaded.canaryRuntime,
    deploymentFacts,
    need,
  );
  verifyEvents(
    loaded.events,
    deploymentFacts,
    compatibilityFacts,
    need,
    {
      database: evidence?.artifacts?.database?.sha256,
      compatibilityProbe: evidence?.artifacts?.compatibilityProbe?.sha256,
    },
    canaryFacts,
    workflowFacts,
  );

  return {
    ok: failures.length === 0,
    failures,
    proofBundleSha256: sha256Utf8(canonicalJson(evidence?.artifacts ?? null)),
  };
}

function verifyDatabase(db, descriptor, need, options) {
  const captureSource = readCheckout(descriptor?.sourceFile, options);
  need(
    descriptor?.sourceFile ===
      "scripts/capture-codex-rotating-production-writer.mjs" &&
      captureSource !== null &&
      sha256(captureSource) === descriptor?.sourceFileSha256,
    "production database capture executable source digest mismatched",
  );
  need(
    db?.observationVersion === 2 &&
      db?.source === "production-postgresql-writer" &&
      db?.captureKind === "database-query" &&
      db?.rehearsal === false,
    "database observation must come from the actual production writer",
  );
  need(
    hasExactKeys(db?.databaseIdentity, [
      "currentDatabase",
      "serverAddress",
      "systemIdentifier",
    ]) &&
      [
        db?.databaseIdentity?.currentDatabase,
        db?.databaseIdentity?.serverAddress,
        db?.databaseIdentity?.systemIdentifier,
      ].every((value) => typeof value === "string" && value.length > 0),
    "production database identity is incomplete",
  );
  need(
    hasExactKeys(db?.callerIdentity, [
      "applicationName",
      "commit",
      "databaseRole",
      "id",
      "imageDigest",
      "kind",
      "sessionUser",
    ]) &&
      db?.callerIdentity?.kind === "immutable-release-migration" &&
      db?.callerIdentity?.id === "release-migration" &&
      db?.callerIdentity?.applicationName ===
        "reviewrouter-release-migration" &&
      typeof db?.callerIdentity?.databaseRole === "string" &&
      db.callerIdentity.databaseRole.length > 0 &&
      typeof db?.callerIdentity?.sessionUser === "string" &&
      db.callerIdentity.sessionUser.length > 0 &&
      /^[a-f0-9]{40}$/u.test(db?.callerIdentity?.commit ?? "") &&
      /^sha256:[a-f0-9]{64}$/u.test(db?.callerIdentity?.imageDigest ?? ""),
    "production migration caller identity is not one immutable release caller",
  );
  verifyDrainObservations(db?.drainObservations, db?.databaseIdentity, need);
  need(
    /^17\./u.test(db?.postgresVersion ?? ""),
    "database observation is not PostgreSQL 17",
  );
  const unsafeWork = db?.unsafeWork;
  need(
    hasExactKeys(unsafeWork, [
      "activeLeasesWithoutPositiveEpoch",
      "activeManifestsWithoutPositiveEpoch",
      "pendingIntents",
      "pendingIntentsWithoutPositiveEpoch",
    ]) &&
      Object.values(unsafeWork).every(
        (value) => Number.isInteger(value) && value >= 0,
      ) &&
      Object.values(unsafeWork).reduce((sum, value) => sum + value, 0) === 0,
    "database observation has unsafe active work",
  );
  need(
    db?.fetchedRecoveryOwner?.startsWith("setup:") === true,
    "fetched ambiguity did not pin recovery",
  );
  need(
    JSON.stringify(db?.migrationSources?.map((entry) => entry.id)) ===
      JSON.stringify(migrations.map((entry) => entry.id)),
    "database migration sources are not the ordered combined release",
  );
  for (const migration of migrations) {
    const source = readCheckout(migration.sourceFile, options);
    const digest = source ? sha256(source) : null;
    const observedSource = db?.migrationSources?.find(
      (entry) => entry.id === migration.id,
    );
    need(
      observedSource?.sha256 === digest,
      `${migration.id} source digest mismatched`,
    );
    const current = db?.history?.filter(
      (entry) =>
        entry.migration_name === migration.id &&
        entry.finished === true &&
        entry.current === true,
    );
    need(
      current?.length === 1,
      `${migration.id} migration history is not exactly one current success`,
    );
    need(
      current?.[0]?.checksum === digest,
      `${migration.id} migration history checksum mismatched`,
    );
    need(
      current?.[0]?.applied_steps_count === 1,
      `${migration.id} migration did not record one applied step`,
    );
  }
  need(
    equalSorted(
      db?.catalog?.triggers?.map((entry) => entry.name),
      exactTriggers,
    ),
    "database trigger catalog is not exact",
  );
  need(
    db?.catalog?.triggers?.every((entry) => exactTriggerBinding(entry)),
    "database trigger bindings are not exact",
  );
  need(
    equalSorted(
      db?.catalog?.checks?.map((entry) => entry.name),
      exactChecks,
    ),
    "database check catalog is not exact",
  );
  need(
    db?.catalog?.checks?.every((entry) => exactCheckDefinition(entry)),
    "database check definitions/validation flags are not exact",
  );
  need(
    equalSorted(
      db?.catalog?.indexes?.map((entry) => entry.name),
      exactIndexes,
    ),
    "database index catalog is not exact",
  );
  need(
    db?.catalog?.indexes?.every((entry) => exactIndexDefinition(entry)),
    "database index definitions/flags are not exact",
  );
  return {
    callerCommit: db?.callerIdentity?.commit,
    callerImageDigest: db?.callerIdentity?.imageDigest,
  };
}

function verifyDrainObservations(observations, databaseIdentity, need) {
  need(
    Array.isArray(observations) && observations.length === 2,
    "exactly two production drain observations are required",
  );
  if (!Array.isArray(observations) || observations.length !== 2) return;
  need(
    observations.every(
      (entry) =>
        hasExactKeys(entry, [
          "activeLeases",
          "fetchedSetups",
          "observedAt",
          "pendingIntents",
          "writerInFlight",
        ]) &&
        [
          entry.activeLeases,
          entry.fetchedSetups,
          entry.pendingIntents,
          entry.writerInFlight,
        ].every((value) => value === 0) &&
        Number.isFinite(Date.parse(entry.observedAt ?? "")),
    ) &&
      Date.parse(observations[1].observedAt) >
        Date.parse(observations[0].observedAt),
    "production in-flight barrier was not stably zero across two observations",
  );
  need(
    databaseIdentity && Object.keys(databaseIdentity).length === 3,
    "drain observations are not bound to one database identity",
  );
}

function exactTriggerBinding(entry) {
  const bindings = {
    CodexOAuthProviderInstance_identity_guard: [
      "CodexOAuthProviderInstance",
      "codex_oauth_provider_identity_guard",
      23,
    ],
    CodexOAuthProviderInstance_mutation_transition_guard: [
      "CodexOAuthProviderInstance",
      "codex_oauth_provider_mutation_transition_guard",
      19,
    ],
    CodexOAuthSetupManifest_identity_fence_guard: [
      "CodexOAuthSetupManifest",
      "codex_oauth_child_identity_fence_guard",
      23,
    ],
    CodexOAuthLease_identity_fence_guard: [
      "CodexOAuthLease",
      "codex_oauth_child_identity_fence_guard",
      23,
    ],
    CodexOAuthWritebackIntent_identity_fence_guard: [
      "CodexOAuthWritebackIntent",
      "codex_oauth_child_identity_fence_guard",
      23,
    ],
    RepositoryConnection_codex_oauth_identity_guard: [
      "RepositoryConnection",
      "codex_oauth_repository_identity_guard",
      17,
    ],
  };
  return (
    JSON.stringify([entry?.table, entry?.function, entry?.type]) ===
    JSON.stringify(bindings[entry?.name])
  );
}
function exactCheckDefinition(entry) {
  const tokens = {
    CodexOAuthProviderInstance_mutation_fence_check: [
      "mutationEpoch",
      "mutationOwner",
      "mutationOwnerId",
      "runtime",
      "setup",
      "recovery",
    ],
    CodexOAuthSetupManifest_epoch_check: [
      "status",
      "issued",
      "fetched",
      "mutationEpoch",
    ],
    CodexOAuthLease_epoch_check: [
      "status",
      "preleased",
      "finalized",
      "mutationEpoch",
    ],
    CodexOAuthWritebackIntent_epoch_check: [
      "status",
      "pending",
      "mutationEpoch",
    ],
  }[entry?.name];
  const expectedValidated =
    entry?.name === "CodexOAuthProviderInstance_mutation_fence_check";
  return (
    Array.isArray(tokens) &&
    entry?.validated === expectedValidated &&
    tokens.every((token) => entry?.definition?.includes(token))
  );
}
function exactIndexDefinition(entry) {
  const keys = {
    CodexOAuthSetupManifest_one_active_provider_key: [
      "providerInstanceRowId",
      "issued",
      "fetched",
    ],
    CodexOAuthProviderInstance_mutation_owner_idx: [
      "mutationOwner",
      "mutationEpoch",
    ],
    CodexOAuthSetupManifest_provider_epoch_idx: [
      "providerInstanceRowId",
      "mutationEpoch",
    ],
    CodexOAuthLease_provider_epoch_idx: [
      "providerInstanceRowId",
      "mutationEpoch",
    ],
    CodexOAuthWritebackIntent_provider_epoch_idx: [
      "providerInstanceRowId",
      "mutationEpoch",
    ],
    CodexOAuthChildIdentityQuarantine_provider_idx: [
      "providerInstanceRowId",
      "resolvedAt",
    ],
  }[entry?.name];
  return (
    Array.isArray(keys) &&
    entry?.valid === true &&
    entry?.ready === true &&
    entry?.unique ===
      (entry?.name === "CodexOAuthSetupManifest_one_active_provider_key") &&
    keys.every((key) =>
      `${entry?.definition} ${entry?.predicate}`.includes(key),
    )
  );
}

function verifyDeployments(observation, need) {
  need(
    observation?.observationVersion === 1 &&
      observation?.source === "render-api",
    "deployments must be captured from the Render API",
  );
  const services = observation?.services ?? [];
  need(
    equalSorted(
      services.map((entry) => entry.name),
      exactServices,
    ),
    "deployments must cover api, web, and worker exactly",
  );
  const commits = new Set(services.map((entry) => entry.commit));
  const images = new Set(services.map((entry) => entry.imageDigest));
  need(
    commits.size === 1 && /^[a-f0-9]{40}$/u.test([...commits][0] ?? ""),
    "deployed services do not converge on one exact commit",
  );
  need(
    images.size === 1 && /^sha256:[a-f0-9]{64}$/u.test([...images][0] ?? ""),
    "deployed services do not converge on one exact image digest",
  );
  need(
    services.every((entry) => entry.rotatingMutationAdmission === "off"),
    "rotating OAuth mutation admission was not off during convergence",
  );
  need(
    services.every(
      (entry) =>
        entry.preDeployCommand === null &&
        entry.serviceMigrationCallerEnabled === false,
    ),
    "Render services still expose independent migration callers",
  );
  need(
    services.every((entry) =>
      Number.isFinite(Date.parse(entry.observedAt ?? "")),
    ),
    "deployment observation timestamps are invalid",
  );
  return {
    commit: [...commits][0],
    imageDigest: [...images][0],
    lastObservedAt: Math.max(
      ...services.map((entry) => Date.parse(entry.observedAt ?? "")),
    ),
  };
}

function verifyCompatibility(probe, descriptor, deployment, need, options) {
  const source = readCheckout(descriptor?.sourceFile, options);
  need(
    source !== null && sha256(source) === descriptor?.sourceFileSha256,
    "compatibility-probe executable source digest mismatched",
  );
  need(
    probe?.observationVersion === 1 && probe?.exitCode === 0,
    "compatibility probe did not execute successfully",
  );
  need(
    probe?.candidateCommit === deployment.commit &&
      probe?.candidateImageDigest === deployment.imageDigest,
    "compatibility probe did not execute against deployed candidate",
  );
  need(
    /^[a-f0-9]{40}$/u.test(probe?.bridgeCommit ?? "") &&
      /^sha256:[a-f0-9]{64}$/u.test(probe?.bridgeImageDigest ?? ""),
    "compatibility probe is not bound to the exact bridge commit and image",
  );
  need(
    probe?.readerRestartCount >= 1,
    "compatibility probe did not observe a reader restart",
  );
  need(
    Array.isArray(probe?.cases) &&
      probe.cases.length === exactCases.length &&
      probe.cases.every(
        (entry, index) =>
          entry.id === exactCases[index] &&
          entry.conclusion === "pass" &&
          entry.observationDigest ===
            sha256Utf8(canonicalJson(entry.observations)),
      ) &&
      exactCompatibilityObservations(probe.cases),
    "compatibility probe cases are missing executable observations or derived digests",
  );
  return {
    bridgeCommit: probe?.bridgeCommit,
    bridgeImageDigest: probe?.bridgeImageDigest,
  };
}

function exactCompatibilityObservations(cases) {
  const replay = cases[0]?.observations;
  const queuedV1 = cases[1]?.observations;
  const v2 = cases[2]?.observations;
  return (
    hasExactKeys(replay, [
      "firstResponseSha256",
      "firstStatus",
      "readerProcessIds",
      "replayResponseSha256",
      "replayStatus",
    ]) &&
    replay.firstStatus === 200 &&
    replay.replayStatus === 200 &&
    replay.firstResponseSha256 === replay.replayResponseSha256 &&
    /^[a-f0-9]{64}$/u.test(replay.firstResponseSha256 ?? "") &&
    Array.isArray(replay.readerProcessIds) &&
    replay.readerProcessIds.length === 2 &&
    replay.readerProcessIds[0] !== replay.readerProcessIds[1] &&
    hasExactKeys(queuedV1, [
      "mutationCount",
      "publishedV2At",
      "queuedWorkflowSha",
      "result",
      "startedAt",
      "workflowSchemaVersion",
    ]) &&
    /^[a-f0-9]{40}$/u.test(queuedV1.queuedWorkflowSha ?? "") &&
    queuedV1.workflowSchemaVersion === 1 &&
    queuedV1.result === "rejected_before_oauth_mutation" &&
    queuedV1.mutationCount === 0 &&
    Date.parse(queuedV1.startedAt) >= Date.parse(queuedV1.publishedV2At) &&
    hasExactKeys(v2, [
      "fenceObserved",
      "mutationEpoch",
      "publishedWorkflowDigest",
      "result",
      "workflowSchemaVersion",
    ]) &&
    v2.workflowSchemaVersion === 2 &&
    v2.result === "success" &&
    v2.fenceObserved === true &&
    Number.isInteger(v2.mutationEpoch) &&
    v2.mutationEpoch > 0 &&
    /^sha256:[a-f0-9]{64}$/u.test(v2.publishedWorkflowDigest ?? "")
  );
}

function verifyWorkflowRuns(observation, need) {
  need(
    observation?.observationVersion === 1 &&
      observation?.source === "github-actions-api",
    "workflow-run inventory must be captured from the GitHub Actions API",
  );
  const samples = observation?.observations;
  need(
    Array.isArray(samples) && samples.length === 2,
    "workflow-run inventory requires two observations",
  );
  if (!Array.isArray(samples) || samples.length !== 2) return null;
  const validRun = (run) =>
    hasExactKeys(run, [
      "headSha",
      "runId",
      "status",
      "workflowPath",
      "workflowSchemaVersion",
    ]) &&
    ["queued", "in_progress"].includes(run.status) &&
    [1, 2].includes(run.workflowSchemaVersion) &&
    /^[a-f0-9]{40}$/u.test(run.headSha ?? "") &&
    typeof run.workflowPath === "string" &&
    String(run.runId).length > 0;
  need(
    samples.every(
      (sample) =>
        Number.isFinite(Date.parse(sample?.observedAt ?? "")) &&
        Array.isArray(sample?.runs) &&
        sample.runs.every(validRun),
    ),
    "queued/in-progress v1/v2 run inventory is incomplete",
  );
  const firstIds = new Set(samples[0]?.runs?.map((run) => String(run.runId)));
  const arrivals = (samples[1]?.runs ?? []).filter(
    (run) => !firstIds.has(String(run.runId)),
  );
  need(
    Date.parse(samples[1]?.observedAt ?? "") >
      Date.parse(samples[0]?.observedAt ?? "") && arrivals.length === 0,
    "new queued/in-progress v1/v2 work arrived between observations",
  );
  return { secondObservedAt: Date.parse(samples[1]?.observedAt ?? "") };
}

function verifyCanaryRuntime(observation, deployment, need) {
  need(
    observation?.observationVersion === 1 &&
      observation?.source === "canary-runtime" &&
      observation?.disposable === true,
    "canary evidence must come from the disposable runtime",
  );
  need(
    observation?.flags?.runtime === "1" &&
      observation?.flags?.newWorkAdmission === "1" &&
      observation?.flags?.setupIssuance === "1",
    "canary runtime did not observe all cutover flags enabled",
  );
  need(
    Array.isArray(observation?.approvedRepositories) &&
      observation.approvedRepositories.length === 1 &&
      observation.approvedRepositories[0] === observation.repositoryFullName,
    "canary runtime was not restricted to exactly one disposable target",
  );
  need(
    observation?.runtimeCommit === deployment.commit &&
      observation?.runtimeImageDigest === deployment.imageDigest,
    "canary runtime is not bound to the deployed commit and image",
  );
  need(
    [
      observation?.installerV1Digest,
      observation?.installerV2Digest,
      observation?.workflowV2Digest,
      observation?.runtimePublicationDigest,
    ].every((digest) => /^sha256:[a-f0-9]{64}$/u.test(digest ?? "")),
    "canary publication digests are incomplete",
  );
  return observation;
}

function verifyEvents(
  events,
  deployment,
  compatibility,
  need,
  artifactDigests,
  canaryRuntime,
  workflowFacts,
) {
  need(
    events?.observationVersion === 1 &&
      events?.source === "operator-command-log",
    "events artifact source is invalid",
  );
  const sequence = events?.events ?? [];
  const expected = [
    "bridge_replay_ready",
    "workflow_v2_published",
    "setup_issuance_disabled",
    "pre_kill_switch_drain_zero",
    "mutation_admission_disabled",
    "post_kill_switch_drain_zero",
    "migrations_completed",
    "services_converged",
    "canary_allowlisted",
    "canary_admission_opened",
    "canary_passed",
    "canary_admission_closed",
    "canary_allowlist_deleted",
    "widening_approved",
    "widening_admission_opened",
  ];
  need(
    sequence.map((entry) => entry.type).join(",") === expected.join(","),
    "full-drain bridge events are missing or out of order",
  );
  need(
    sequence.every(
      (entry, index) =>
        Number.isFinite(Date.parse(entry.observedAt ?? "")) &&
        (index === 0 ||
          Date.parse(entry.observedAt) >=
            Date.parse(sequence[index - 1].observedAt)),
    ),
    "event timestamps are invalid or out of order",
  );
  const bridge = sequence.find((entry) => entry.type === "bridge_replay_ready");
  need(
    /^[a-f0-9]{40}$/u.test(bridge?.commit ?? "") &&
      /^sha256:[a-f0-9]{64}$/u.test(bridge?.imageDigest ?? "") &&
      bridge?.commit === compatibility.bridgeCommit &&
      bridge?.imageDigest === compatibility.bridgeImageDigest &&
      bridge?.databaseCompatibility === "pre-000061" &&
      bridge?.exactConsumedReplayObserved === true,
    "bridge event lacks pre-000061 compatibility, exact commit/image, or consumed-replay observation",
  );
  const publication = sequence.find(
    (entry) => entry.type === "workflow_v2_published",
  );
  need(
    [
      publication?.installerV1Digest,
      publication?.installerV2Digest,
      publication?.workflowV2Digest,
    ].every((digest) => /^sha256:[a-f0-9]{64}$/u.test(digest ?? "")),
    "v1/v2 installer and v2 workflow publication digests are missing",
  );
  need(
    publication?.installerV1Digest === canaryRuntime?.installerV1Digest &&
      publication?.installerV2Digest === canaryRuntime?.installerV2Digest &&
      publication?.workflowV2Digest === canaryRuntime?.workflowV2Digest,
    "published installer/workflow digests are not bound to canary runtime evidence",
  );
  need(
    publication?.v2IssuanceCount === 0,
    "v2 issuance was observed before v1/v2 installer and workflow publication",
  );
  const issuanceDisabled = sequence.find(
    (entry) => entry.type === "setup_issuance_disabled",
  );
  need(
    issuanceDisabled?.setupIssuance === "off" &&
      issuanceDisabled?.probe?.httpStatus === 503 &&
      issuanceDisabled?.probe?.code ===
        "codex_rotating_setup_issuance_quiesced",
    "setup issuance was not observably quiesced before the full kill switch",
  );
  const disabled = sequence.find(
    (entry) => entry.type === "mutation_admission_disabled",
  );
  need(
    disabled?.globalMutationAdmission === "off" &&
      disabled?.setupIssuance === "off" &&
      disabled?.exactConsumedReplayStillAvailable === true,
    "both rotating OAuth mutation switches must be observed off",
  );
  for (const type of [
    "pre_kill_switch_drain_zero",
    "post_kill_switch_drain_zero",
  ]) {
    const drain = sequence.find((entry) => entry.type === type);
    need(
      drain?.activeLeases === 0 &&
        drain?.fetchedSetups === 0 &&
        drain?.pendingIntents === 0 &&
        drain?.queuedOldWorkflows === 0,
      `${type} observation is not zero, including queued old workflows`,
    );
  }
  need(
    Date.parse(
      sequence.find((entry) => entry.type === "post_kill_switch_drain_zero")
        ?.observedAt ?? "",
    ) >= (workflowFacts?.secondObservedAt ?? Number.POSITIVE_INFINITY),
    "drain event precedes the second no-arrival workflow observation",
  );
  const migration = sequence.find(
    (entry) => entry.type === "migrations_completed",
  );
  need(
    JSON.stringify(migration?.ids) ===
      JSON.stringify(migrations.map((entry) => entry.id)),
    "event log does not prove ordered combined migration IDs",
  );
  need(
    migration?.databaseArtifactSha256 === artifactDigests.database,
    "migration event is not bound to the production database artifact",
  );
  const convergence = sequence.find(
    (entry) => entry.type === "services_converged",
  );
  need(
    convergence?.commit === deployment.commit &&
      convergence?.imageDigest === deployment.imageDigest &&
      convergence?.mutationAdmission === "off" &&
      Date.parse(convergence?.observedAt ?? "") >= deployment.lastObservedAt,
    "event convergence is not bound to observed deployment with admission off",
  );
  const canary = sequence.find((entry) => entry.type === "canary_allowlisted");
  need(
    canary?.globalMutationAdmission === "off" && canary?.disposable === true,
    "canary was not disposable and allowlisted with the global switch off",
  );
  const canaryAdmission = sequence.find(
    (entry) => entry.type === "canary_admission_opened",
  );
  need(
    canaryAdmission?.scope === "single-disposable-repository" &&
      canaryAdmission?.allowlistCount === 1 &&
      canaryAdmission?.runtimeFlag === "1" &&
      canaryAdmission?.newWorkAdmissionFlag === "1" &&
      canaryAdmission?.setupIssuanceFlag === "1",
    "canary admission was not restricted to one disposable repository",
  );
  const canaryPassed = sequence.find((entry) => entry.type === "canary_passed");
  need(
    canaryPassed?.compatibilityArtifactSha256 ===
      artifactDigests.compatibilityProbe &&
      canaryPassed?.runtimePublicationDigest ===
        canaryRuntime?.runtimePublicationDigest,
    "canary pass is not bound to the compatibility-probe artifact digest",
  );
  const canaryClosed = sequence.find(
    (entry) => entry.type === "canary_admission_closed",
  );
  const canaryDeleted = sequence.find(
    (entry) => entry.type === "canary_allowlist_deleted",
  );
  need(
    canaryClosed?.runtimeFlag === "0" &&
      canaryClosed?.newWorkAdmissionFlag === "0" &&
      canaryClosed?.setupIssuanceFlag === "0" &&
      Date.parse(canaryClosed?.observedAt ?? "") <
        Date.parse(canaryDeleted?.observedAt ?? ""),
    "canary flags did not return to zero before allowlist deletion",
  );
  need(
    canaryDeleted?.allowlistCount === 0 &&
      canaryDeleted?.runtimeFlag === "0" &&
      canaryDeleted?.newWorkAdmissionFlag === "0" &&
      canaryDeleted?.setupIssuanceFlag === "0",
    "clearing the canary allowlist while admission is on is prohibited",
  );
  const widening = sequence.find((entry) => entry.type === "widening_approved");
  const wideningOpened = sequence.find(
    (entry) => entry.type === "widening_admission_opened",
  );
  need(
    Array.isArray(widening?.approvedRepositories) &&
      widening.approvedRepositories.length > 0,
    "widening requires a nonempty explicit approved cohort",
  );
  need(
    wideningOpened?.runtimeFlag === "1" &&
      wideningOpened?.newWorkAdmissionFlag === "1" &&
      wideningOpened?.setupIssuanceFlag === "1" &&
      wideningOpened?.allowlistCount ===
        widening?.approvedRepositories?.length &&
      wideningOpened.allowlistCount > 0,
    "widening admission did not retain a nonempty approved cohort",
  );
  need(
    sequence.every(
      (entry) =>
        entry.allowlistCount !== 0 ||
        (entry.runtimeFlag !== "1" &&
          entry.newWorkAdmissionFlag !== "1" &&
          entry.setupIssuanceFlag !== "1"),
    ),
    "allowlist was cleared while admission was enabled",
  );
  need(
    events?.rollbackFloorCommit === deployment.commit,
    "rollback floor must be the fence-aware deployed commit",
  );
  need(
    events?.prohibitedRollbackCommit === "e642d1ed",
    "e642d1ed must be explicitly prohibited after 000061",
  );
}

function loadArtifact(descriptor, options) {
  if (!descriptor || typeof descriptor.path !== "string")
    return { value: null, digestValid: false };
  try {
    const path = options.evidenceDirectory
      ? resolve(options.evidenceDirectory, descriptor.path)
      : descriptor.path;
    const bytes = options.readArtifact
      ? options.readArtifact(path)
      : readFileSync(path);
    return {
      value: JSON.parse(bytes.toString("utf8")),
      digestValid:
        /^[a-f0-9]{64}$/u.test(descriptor.sha256 ?? "") &&
        sha256(bytes) === descriptor.sha256,
    };
  } catch {
    return { value: null, digestValid: false };
  }
}

function readCheckout(sourceFile, options) {
  if (typeof sourceFile !== "string") return null;
  const path = resolve(checkoutRoot, sourceFile);
  if (!path.startsWith(`${checkoutRoot}${sep}`)) return null;
  try {
    return options.readSource ? options.readSource(path) : readFileSync(path);
  } catch {
    return null;
  }
}
function hasExactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    equalSorted(Object.keys(value), keys)
  );
}
function equalSorted(left, right) {
  return (
    JSON.stringify([...(left ?? [])].sort()) ===
    JSON.stringify([...right].sort())
  );
}
function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = runCodexRotatingRolloutVerifierCli(process.argv.slice(2));
