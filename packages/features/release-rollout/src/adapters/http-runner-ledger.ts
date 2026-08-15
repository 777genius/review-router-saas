import type {
  CreateRunnerProvisioningIntent,
  PersistedRunnerJob,
  RunnerProvisioningIntent,
  RunnerCleanupWitnessPort,
  RunnerJobLedger,
} from "./render-private-runner";
import type { RenderFetch } from "./render-api";
import { BoundedProviderHttpClient } from "./bounded-provider-io";
import type {
  ActivationAuthorization,
  ActivationReceipt,
  AuthoritativeGenerationLedger,
  ReleaseMigrationReceipt,
  StepObservation,
  TargetSwitchFence,
} from "../domain/release-rollout";
import type { ReleaseMigrationPermit } from "../domain/release-migration-transition";
import type { ServiceTransitionCheckpoint } from "../application/transactional-service-cutover";
import type { ServiceTransitionLedger } from "../application/transactional-service-cutover";
import type { RunnerIdentity } from "../domain/release-rollout";
import type { CompensationCheckpoint } from "../application/ports";
import {
  assertExternalEffectRecord,
  assertRunnerProvisioningIntentRecord,
  type ExternalEffectControlReconciliation,
  type ExternalEffectRecord,
} from "../domain/external-effect";
import {
  assertRecoveryEffectConsumptionResult,
  assertRecoveryEffectRecordBinding,
} from "../domain/recovery-effect";
import {
  fromRenderSourceRecoveryManifestV1,
  fromRenderTargetServiceContractV1,
  toRenderSourceRecoveryManifestV1,
  toRenderTargetServiceContractV1,
  type RenderSourceRecoveryManifestV1,
  type RenderTargetServiceContractV1,
} from "./render-service-transition-compatibility";

const migrationRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("runner_ledger_migration_response_invalid");
  return value as Record<string, unknown>;
};
const migrationExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const migrationDigest = /^sha256:[a-f0-9]{64}$/u;
const migrationSystem = /^[1-9][0-9]{0,19}$/u;
const migrationPermitResponse = (value: unknown): ReleaseMigrationPermit => {
  const item = migrationRecord(value);
  if (
    !migrationExactKeys(item, [
      "schemaVersion",
      "rolloutId",
      "runId",
      "runAttempt",
      "targetSystemIdentifier",
      "targetRecoveryWitnessSha256",
      "transitionSha256",
      "expectedPreviousReceiptSha256",
      "epoch",
      "nonce",
    ]) ||
    item.schemaVersion !== 1 ||
    typeof item.rolloutId !== "string" ||
    typeof item.runId !== "string" ||
    item.runAttempt !== 1 ||
    typeof item.targetSystemIdentifier !== "string" ||
    !migrationSystem.test(item.targetSystemIdentifier) ||
    typeof item.targetRecoveryWitnessSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(item.targetRecoveryWitnessSha256) ||
    typeof item.transitionSha256 !== "string" ||
    !migrationDigest.test(item.transitionSha256) ||
    typeof item.expectedPreviousReceiptSha256 !== "string" ||
    !migrationDigest.test(item.expectedPreviousReceiptSha256) ||
    !Number.isSafeInteger(item.epoch) ||
    Number(item.epoch) < 1 ||
    typeof item.nonce !== "string" ||
    !/^[a-f0-9]{32}$/u.test(item.nonce)
  )
    throw new Error("runner_ledger_migration_permit_invalid");
  return item as ReleaseMigrationPermit;
};

const migrationReceiptResponse = (value: unknown): ReleaseMigrationReceipt => {
  const item = migrationRecord(value);
  const keys = [
    "step",
    "receiptId",
    "observedAt",
    "rolloutId",
    "expectedCommitSha",
    "runId",
    "runAttempt",
    "sourceSystemIdentifier",
    "targetSystemIdentifier",
    "observationSha256",
    "previousReceiptSha256",
    "receiptSha256",
    "migrationChecksum",
    "transitionSha256",
    "migrationArtifactDigest",
    "migrationBundleSha256",
    "preManifestIdentity",
    "postManifestIdentity",
    "postCatalogDigest",
    "permitEpoch",
    "permitNonce",
  ];
  if (
    (!migrationExactKeys(item, keys) &&
      !migrationExactKeys(item, [...keys, "provider"])) ||
    item.step !== "run_release_migration" ||
    typeof item.receiptId !== "string" ||
    typeof item.observedAt !== "string" ||
    !Number.isFinite(Date.parse(item.observedAt)) ||
    typeof item.rolloutId !== "string" ||
    typeof item.expectedCommitSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(item.expectedCommitSha) ||
    typeof item.runId !== "string" ||
    item.runAttempt !== 1 ||
    typeof item.sourceSystemIdentifier !== "string" ||
    !migrationSystem.test(item.sourceSystemIdentifier) ||
    typeof item.targetSystemIdentifier !== "string" ||
    !migrationSystem.test(item.targetSystemIdentifier) ||
    item.sourceSystemIdentifier === item.targetSystemIdentifier ||
    [
      "observationSha256",
      "previousReceiptSha256",
      "receiptSha256",
      "migrationChecksum",
      "transitionSha256",
      "migrationArtifactDigest",
      "migrationBundleSha256",
      "preManifestIdentity",
      "postManifestIdentity",
      "postCatalogDigest",
    ].some(
      (key) =>
        typeof item[key] !== "string" ||
        !migrationDigest.test(String(item[key])),
    ) ||
    !Number.isSafeInteger(item.permitEpoch) ||
    Number(item.permitEpoch) < 1 ||
    typeof item.permitNonce !== "string" ||
    !/^[a-f0-9]{32}$/u.test(item.permitNonce) ||
    (Object.hasOwn(item, "provider") && item.provider !== null)
  )
    throw new Error("runner_ledger_migration_receipt_invalid");
  return { ...item, provider: undefined } as ReleaseMigrationReceipt;
};

export class AuthenticatedRunnerLedgerAdapter
  implements
    RunnerJobLedger,
    RunnerCleanupWitnessPort,
    AuthoritativeGenerationLedger
{
  private readonly fetchImpl: RenderFetch;
  constructor(
    private readonly origin: string,
    private readonly token: string,
    fetchImpl: RenderFetch = fetch,
  ) {
    if (!origin.startsWith("https://") || !token)
      throw new Error("runner_ledger_configuration_invalid");
    const http = new BoundedProviderHttpClient(fetchImpl);
    this.fetchImpl = (url, init) => http.request("authority", url, init);
  }
  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const response = await this.fetchImpl(
      `${this.origin.replace(/\/$/u, "")}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      },
    );
    if (!response.ok)
      throw new Error(`runner_ledger_request_failed:${response.status}`);
    return response.status === 204 ? null : await response.json();
  }
  async persistCreatedJob(value: PersistedRunnerJob): Promise<void> {
    await this.request("/v1/runner-jobs", {
      method: "POST",
      body: JSON.stringify(value),
    });
  }
  async persistProvisioningIntent(
    value: CreateRunnerProvisioningIntent,
  ): Promise<ExternalEffectRecord> {
    const result = (await this.request("/v1/runner-jobs/intents", {
      method: "POST",
      body: JSON.stringify(value),
    })) as Record<string, unknown>;
    return assertExternalEffectRecord(
      result as unknown as ExternalEffectRecord,
    );
  }
  async listProvisioningIntents(
    rolloutId: string,
  ): Promise<readonly RunnerProvisioningIntent[]> {
    const value = await this.request(
      `/v1/runner-jobs/intents?rollout_id=${encodeURIComponent(rolloutId)}`,
    );
    if (!Array.isArray(value))
      throw new Error("runner_ledger_provisioning_intents_invalid");
    try {
      for (const entry of value) assertRunnerProvisioningIntentRecord(entry);
    } catch {
      throw new Error("runner_ledger_provisioning_intents_invalid");
    }
    return value as RunnerProvisioningIntent[];
  }
  async acquireProviderDispatchPermit(
    input: Parameters<RunnerJobLedger["acquireProviderDispatchPermit"]>[0],
  ): ReturnType<RunnerJobLedger["acquireProviderDispatchPermit"]> {
    const value = (await this.request(
      `/v1/runner-jobs/intents/${encodeURIComponent(input.intentId)}/dispatch-permit`,
      { method: "POST", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    return assertExternalEffectRecord(value as unknown as ExternalEffectRecord);
  }
  async abandonPreparedEffect(input: {
    intentId: string;
    claimantId: string;
    expectedEpoch: number;
  }): Promise<ExternalEffectRecord> {
    const value = await this.request(
      `/v1/runner-jobs/intents/${encodeURIComponent(input.intentId)}/abandon`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return assertExternalEffectRecord(value as ExternalEffectRecord);
  }
  async reconcileProvisioningEffect(input: {
    intentId: string;
    claimantId: string;
    expectedEpoch: number;
    jobId?: string;
    reconciliation: ExternalEffectControlReconciliation;
    observation?: StepObservation;
  }): Promise<ExternalEffectRecord> {
    const value = await this.request(
      `/v1/runner-jobs/intents/${encodeURIComponent(input.intentId)}/reconciliation`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return assertExternalEffectRecord(value as ExternalEffectRecord);
  }
  async listOpenJobs(
    rolloutId: string,
  ): Promise<readonly PersistedRunnerJob[]> {
    const value = await this.request(
      `/v1/runner-jobs?rollout_id=${encodeURIComponent(rolloutId)}&state=open`,
    );
    if (!Array.isArray(value))
      throw new Error("runner_ledger_open_jobs_invalid");
    return value as PersistedRunnerJob[];
  }
  async markTerminal(
    jobId: string,
    observation: StepObservation,
  ): Promise<void> {
    await this.request(
      `/v1/runner-jobs/${encodeURIComponent(jobId)}/terminal`,
      { method: "PUT", body: JSON.stringify({ observation }) },
    );
  }
  async persistValidatedIdentity(
    jobId: string,
    identity: RunnerIdentity,
    observation: StepObservation,
  ): Promise<void> {
    await this.request(
      `/v1/runner-jobs/${encodeURIComponent(jobId)}/identity`,
      { method: "PUT", body: JSON.stringify({ identity, observation }) },
    );
  }
  async persistRegistration(input: {
    rolloutId: string;
    lifecycle: "role" | "cutover";
    workflowJobId: string;
    registration: {
      runnerId: number;
      runnerGroupId: number;
      labels: readonly string[];
      uniqueLabel: string;
      workFolder: string;
    };
  }): Promise<void> {
    await this.request("/v1/runner-jobs/registration", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async currentRunner(
    rolloutId: string,
    lifecycle: "role" | "cutover",
  ): Promise<{ identity: RunnerIdentity; observation: StepObservation }> {
    const value = (await this.request(
      `/v1/runner-jobs/current?rollout_id=${encodeURIComponent(rolloutId)}&lifecycle=${lifecycle}`,
    )) as Record<string, unknown>;
    if (!value.identity || !value.observation)
      throw new Error("runner_ledger_current_identity_invalid");
    return value as unknown as {
      identity: RunnerIdentity;
      observation: StepObservation;
    };
  }
  async cleanupObservation(jobId: string): Promise<StepObservation> {
    const value = await this.request(
      `/v1/runner-jobs/${encodeURIComponent(jobId)}/cleanup-observation`,
    );
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as StepObservation).step !== "string"
    )
      throw new Error("runner_ledger_cleanup_observation_invalid");
    return value as StepObservation;
  }
  async observe(
    jobId: string,
    expectedCanary: string,
  ): Promise<{
    providerStatus: "succeeded" | "failed" | "canceled";
    listenerStopped: true;
    workspaceRemoved: true;
    credentialProcessGone: true;
    canary: string;
    observedAt: string;
  }> {
    const value = (await this.request(
      `/v1/runner-jobs/${encodeURIComponent(jobId)}/cleanup-witness`,
    )) as Record<string, unknown>;
    if (
      !["succeeded", "failed", "canceled"].includes(
        String(value.providerStatus),
      ) ||
      value.listenerStopped !== true ||
      value.workspaceRemoved !== true ||
      value.credentialProcessGone !== true ||
      value.canary !== expectedCanary ||
      typeof value.observedAt !== "string"
    )
      throw new Error("runner_ledger_cleanup_witness_invalid");
    return value as {
      providerStatus: "succeeded" | "failed" | "canceled";
      listenerStopped: true;
      workspaceRemoved: true;
      credentialProcessGone: true;
      canary: string;
      observedAt: string;
    };
  }
  async claim(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    targetRecoveryWitnessSha256: string;
    migrationTransition: import("../domain/release-migration-transition").ReleaseMigrationTransitionV1;
  }): Promise<"claimed" | "duplicate"> {
    const value = (await this.request("/v1/rollouts/claim", {
      method: "POST",
      body: JSON.stringify(input),
    })) as Record<string, unknown>;
    if (value.result !== "claimed" && value.result !== "duplicate")
      throw new Error("runner_ledger_rollout_claim_invalid");
    return value.result;
  }
  async beginReleaseMigration(
    input: Parameters<
      NonNullable<AuthoritativeGenerationLedger["beginReleaseMigration"]>
    >[0],
  ): Promise<ReleaseMigrationPermit> {
    const value = await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/release-migration/begin`,
      { method: "POST", body: JSON.stringify(input) },
    );
    const envelope = migrationRecord(value);
    if (!migrationExactKeys(envelope, ["permit"]))
      throw new Error("runner_ledger_migration_permit_missing");
    return migrationPermitResponse(envelope.permit);
  }
  async completeReleaseMigration(
    input: Parameters<
      NonNullable<AuthoritativeGenerationLedger["completeReleaseMigration"]>
    >[0],
  ): Promise<ReleaseMigrationReceipt> {
    const value = await this.request(
      `/v1/rollouts/${encodeURIComponent(input.permit.rolloutId)}/release-migration/complete`,
      { method: "POST", body: JSON.stringify(input) },
    );
    const envelope = migrationRecord(value);
    if (!migrationExactKeys(envelope, ["receipt"]))
      throw new Error("runner_ledger_migration_receipt_missing");
    return migrationReceiptResponse(envelope.receipt);
  }
  async failReleaseMigration(
    input: Parameters<
      NonNullable<AuthoritativeGenerationLedger["failReleaseMigration"]>
    >[0],
  ): Promise<void> {
    await this.request(
      `/v1/rollouts/${encodeURIComponent(input.permit.rolloutId)}/release-migration/fail`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  async loadReleaseMigrationCheckpoint(
    input: Parameters<
      NonNullable<
        AuthoritativeGenerationLedger["loadReleaseMigrationCheckpoint"]
      >
    >[0],
  ): Promise<
    Awaited<
      ReturnType<
        NonNullable<
          AuthoritativeGenerationLedger["loadReleaseMigrationCheckpoint"]
        >
      >
    >
  > {
    const envelope = migrationRecord(
      await this.request(
        `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/release-migration/checkpoint?target_system_identifier=${encodeURIComponent(input.targetSystemIdentifier)}`,
      ),
    );
    if (
      !migrationExactKeys(envelope, [
        "targetManifestPhase",
        "permit",
        "receipt",
      ]) ||
      !["pre_migration", "migrating", "post_migration", "quarantined"].includes(
        String(envelope.targetManifestPhase),
      )
    )
      throw new Error("runner_ledger_migration_checkpoint_invalid");
    return {
      targetManifestPhase: envelope.targetManifestPhase,
      permit:
        envelope.permit === null
          ? null
          : migrationPermitResponse(envelope.permit),
      receipt:
        envelope.receipt === null
          ? null
          : migrationReceiptResponse(envelope.receipt),
    } as Awaited<
      ReturnType<
        NonNullable<
          AuthoritativeGenerationLedger["loadReleaseMigrationCheckpoint"]
        >
      >
    >;
  }
  async compareAndSet(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    step: import("../domain/release-rollout").RolloutStep;
    provider: StepObservation["provider"];
    expectedReceiptSha256: string;
    nextReceiptSha256: string;
    authoritativeSystemIdentifier: string;
    expectedActivationBoundary: "before" | "activated" | "uncertain";
    nextActivationBoundary: "before" | "activated" | "uncertain";
  }): Promise<boolean> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/cas`,
      { method: "POST", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    if (typeof value.changed !== "boolean")
      throw new Error("runner_ledger_rollout_cas_invalid");
    return value.changed;
  }
  async markActivationUncertain(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
  }): Promise<void> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/activation-uncertain`,
      { method: "PUT", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    if (value.marked !== true)
      throw new Error("runner_ledger_activation_uncertain_mark_invalid");
  }
  async fenceTargetSwitch(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    previousReceiptSha256: string;
  }): Promise<TargetSwitchFence | null> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/target-switch-fence`,
      { method: "POST", body: JSON.stringify(input) },
    )) as { changed?: unknown; fence?: TargetSwitchFence };
    if (value.changed === false) return null;
    const fence = value.fence;
    if (
      value.changed !== true ||
      !fence ||
      fence.rolloutId !== input.rolloutId ||
      fence.expectedCommitSha !== input.expectedCommitSha ||
      fence.runId !== input.runId ||
      fence.runAttempt !== input.runAttempt ||
      fence.sourceSystemIdentifier !== input.sourceSystemIdentifier ||
      fence.targetSystemIdentifier !== input.targetSystemIdentifier ||
      fence.previousReceiptSha256 !== input.previousReceiptSha256 ||
      !/^[a-f0-9]{32}$/u.test(fence.nonce) ||
      !Number.isSafeInteger(fence.version) ||
      fence.version < 1
    )
      throw new Error("runner_ledger_target_switch_fence_invalid");
    return fence;
  }
  async authorizeActivation(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    jobId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    previousReceiptSha256: string;
    targetDeployIds: readonly string[];
    postgresMajor: 17;
    migrationChecksum: string;
  }): Promise<ActivationAuthorization> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/activation-authorization`,
      { method: "POST", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    const authorization = value.authorization as
      | ActivationAuthorization
      | undefined;
    if (
      !authorization ||
      authorization.rolloutId !== input.rolloutId ||
      authorization.expectedCommitSha !== input.expectedCommitSha ||
      authorization.postgresMajor !== input.postgresMajor ||
      authorization.migrationChecksum !== input.migrationChecksum ||
      authorization.sourceSystemIdentifier !== input.sourceSystemIdentifier ||
      authorization.targetSystemIdentifier !== input.targetSystemIdentifier ||
      authorization.previousReceiptSha256 !== input.previousReceiptSha256 ||
      JSON.stringify(authorization.targetDeployIds) !==
        JSON.stringify(input.targetDeployIds) ||
      !/^[a-f0-9]{32}$/u.test(authorization.nonce) ||
      !Number.isSafeInteger(authorization.epoch) ||
      authorization.epoch < 1 ||
      Number.isNaN(Date.parse(authorization.authorizedAt))
    )
      throw new Error("runner_ledger_activation_authorization_invalid");
    return authorization;
  }
  async finalizeActivation(input: {
    authorization: ActivationAuthorization;
    provider: StepObservation["provider"];
    nextReceiptSha256: string;
    activationReceipt: ActivationReceipt;
  }): Promise<boolean> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.authorization.rolloutId)}/activation-finalize`,
      { method: "POST", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    if (typeof value.changed !== "boolean")
      throw new Error("runner_ledger_activation_finalize_invalid");
    return value.changed;
  }
  async observeActivationState(input: {
    rolloutId: string;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
  }): Promise<"before" | "uncertain" | "activated"> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/activation-state?source_system_identifier=${encodeURIComponent(input.sourceSystemIdentifier)}&target_system_identifier=${encodeURIComponent(input.targetSystemIdentifier)}`,
    )) as Record<string, unknown>;
    if (!["before", "uncertain", "activated"].includes(String(value.state)))
      throw new Error("runner_ledger_activation_state_invalid");
    return value.state as "before" | "uncertain" | "activated";
  }
  async observeCompensationCheckpoint(input: {
    rolloutId: string;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
  }): Promise<CompensationCheckpoint> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/compensation-checkpoint?source_system_identifier=${encodeURIComponent(input.sourceSystemIdentifier)}&target_system_identifier=${encodeURIComponent(input.targetSystemIdentifier)}`,
    )) as Record<string, unknown>;
    const freeze = value.sourceFreeze as Record<string, unknown> | undefined;
    const freezeServices = freeze?.services;
    const freezeServiceIds = freeze?.serviceIds;
    if (
      !["before", "uncertain", "activated"].includes(
        String(value.activationBoundary),
      ) ||
      ![
        "pre_activation",
        "compensating",
        "compensated",
        "activation_authorized",
        "activated",
        "outcome_unknown",
        "forward_repair_required",
      ].includes(String(value.state)) ||
      !/^sha256:[a-f0-9]{64}$/u.test(String(value.lastReceiptSha256)) ||
      (value.lastStep !== null && typeof value.lastStep !== "string") ||
      !Number.isSafeInteger(value.receiptCount) ||
      Number(value.receiptCount) < 0 ||
      !freeze ||
      !["none", "partial", "complete", "unknown"].includes(
        String(freeze.status),
      ) ||
      !Array.isArray(freezeServices) ||
      !Array.isArray(freezeServiceIds) ||
      freezeServices.length !== freezeServiceIds.length ||
      new Set(freezeServiceIds).size !== freezeServiceIds.length ||
      freezeServices.some((service, index) => {
        if (!service || typeof service !== "object" || Array.isArray(service))
          return true;
        const item = service as Record<string, unknown>;
        return (
          item.serviceId !== freezeServiceIds[index] ||
          !/^srv-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
            String(item.serviceId),
          ) ||
          typeof item.latestSuccessfulDeployId !== "string" ||
          !item.latestSuccessfulDeployId ||
          typeof item.observedAt !== "string" ||
          !Number.isFinite(Date.parse(item.observedAt))
        );
      }) ||
      (freeze.status === "none" && freezeServiceIds.length > 0) ||
      ((freeze.status === "partial" || freeze.status === "complete") &&
        freezeServiceIds.length === 0)
    )
      throw new Error("runner_ledger_compensation_checkpoint_invalid");
    return value as unknown as CompensationCheckpoint;
  }
  async begin(
    input: Parameters<ServiceTransitionLedger["begin"]>[0],
  ): Promise<"created" | "existing"> {
    const value = (await this.request("/v1/service-transitions", {
      method: "POST",
      body: JSON.stringify({
        ...input,
        sourceManifest: toRenderSourceRecoveryManifestV1(input.sourceManifest),
        targetContracts: input.targetContracts.map(
          toRenderTargetServiceContractV1,
        ),
      }),
    })) as Record<string, unknown>;
    if (value.result !== "created" && value.result !== "existing")
      throw new Error("runner_ledger_service_transition_begin_invalid");
    return value.result;
  }
  async readContract(
    rolloutId: string,
  ): Promise<Awaited<ReturnType<ServiceTransitionLedger["readContract"]>>> {
    const value = (await this.request(
      `/v1/service-transitions/${encodeURIComponent(rolloutId)}/contract`,
    )) as {
      sourceManifest: RenderSourceRecoveryManifestV1;
      targetContracts: readonly RenderTargetServiceContractV1[];
    } | null;
    return value
      ? {
          sourceManifest: fromRenderSourceRecoveryManifestV1(
            value.sourceManifest,
          ),
          targetContracts: value.targetContracts.map(
            fromRenderTargetServiceContractV1,
          ),
        }
      : null;
  }
  async append(
    checkpoint: Omit<ServiceTransitionCheckpoint, "sequence">,
  ): Promise<ServiceTransitionCheckpoint> {
    const { rolloutId, ...body } = checkpoint;
    const value = (await this.request(
      `/v1/service-transitions/${encodeURIComponent(rolloutId)}/checkpoints`,
      { method: "POST", body: JSON.stringify(body) },
    )) as Record<string, unknown>;
    if (!value.checkpoint || typeof value.checkpoint !== "object")
      throw new Error("runner_ledger_service_transition_checkpoint_invalid");
    return value.checkpoint as ServiceTransitionCheckpoint;
  }
  async read(
    rolloutId: string,
  ): Promise<readonly ServiceTransitionCheckpoint[]> {
    const value = await this.request(
      `/v1/service-transitions/${encodeURIComponent(rolloutId)}/checkpoints`,
    );
    if (!Array.isArray(value))
      throw new Error("runner_ledger_service_transition_read_invalid");
    return value as ServiceTransitionCheckpoint[];
  }
  async complete(input: {
    rolloutId: string;
    outcome: "target_staged" | "source_recovered";
  }): Promise<void> {
    await this.request(
      `/v1/service-transitions/${encodeURIComponent(input.rolloutId)}/complete`,
      { method: "POST", body: JSON.stringify({ outcome: input.outcome }) },
    );
  }
  async intendRecoveryEffect(
    input: Parameters<ServiceTransitionLedger["intendRecoveryEffect"]>[0],
  ): ReturnType<ServiceTransitionLedger["intendRecoveryEffect"]> {
    return assertRecoveryEffectRecordBinding(
      await this.request(
        `/v1/service-transitions/${encodeURIComponent(input.rolloutId)}/recovery-effects/intend`,
        { method: "POST", body: JSON.stringify(input) },
      ),
      {
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: input.kind,
        serviceId: input.serviceId ?? null,
      },
    );
  }
  async claimRecoveryEffect(
    input: Parameters<ServiceTransitionLedger["claimRecoveryEffect"]>[0],
  ): ReturnType<ServiceTransitionLedger["claimRecoveryEffect"]> {
    return assertRecoveryEffectRecordBinding(
      await this.request(
        `/v1/service-transitions/${encodeURIComponent(input.rolloutId)}/recovery-effects/claim`,
        { method: "POST", body: JSON.stringify(input) },
      ),
      {
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: input.kind,
        ownerId: input.ownerId,
      },
    );
  }
  async consumeRecoveryEffectPermit(
    input: Parameters<
      ServiceTransitionLedger["consumeRecoveryEffectPermit"]
    >[0],
  ): ReturnType<ServiceTransitionLedger["consumeRecoveryEffectPermit"]> {
    return assertRecoveryEffectConsumptionResult(
      await this.request(
        `/v1/service-transitions/${encodeURIComponent(input.rolloutId)}/recovery-effects/consume`,
        { method: "POST", body: JSON.stringify(input) },
      ),
      {
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: input.kind,
        ownerId: input.ownerId,
        epoch: input.epoch,
        permitToken: input.permitToken,
      },
    );
  }
  async completeRecoveryEffect(
    input: Parameters<ServiceTransitionLedger["completeRecoveryEffect"]>[0],
  ): ReturnType<ServiceTransitionLedger["completeRecoveryEffect"]> {
    return assertRecoveryEffectRecordBinding(
      await this.request(
        `/v1/service-transitions/${encodeURIComponent(input.rolloutId)}/recovery-effects/complete`,
        { method: "POST", body: JSON.stringify(input) },
      ),
      {
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: input.kind,
        ownerId: input.ownerId,
        epoch: input.epoch,
        permitToken: input.permitToken,
      },
    );
  }
  async validateRecoveryEffectExecution(
    input: Parameters<
      ServiceTransitionLedger["validateRecoveryEffectExecution"]
    >[0],
  ): ReturnType<ServiceTransitionLedger["validateRecoveryEffectExecution"]> {
    return assertRecoveryEffectConsumptionResult(
      await this.request(
        `/v1/service-transitions/${encodeURIComponent(input.rolloutId)}/recovery-effects/validate-execution`,
        { method: "POST", body: JSON.stringify(input) },
      ),
      input,
    );
  }
  async reconcileRecoveryEffect(
    input: Parameters<ServiceTransitionLedger["reconcileRecoveryEffect"]>[0],
  ): ReturnType<ServiceTransitionLedger["reconcileRecoveryEffect"]> {
    return assertRecoveryEffectRecordBinding(
      await this.request(
        `/v1/service-transitions/${encodeURIComponent(input.rolloutId)}/recovery-effects/reconcile`,
        { method: "POST", body: JSON.stringify(input) },
      ),
      input,
    );
  }
  async recordSourceFreezeMutation(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    serviceId: string;
    latestSuccessfulDeployId: string;
    observedAt: string;
    declaredServiceIds: readonly string[];
  }): Promise<"recorded" | "existing"> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/source-freeze-mutations`,
      { method: "POST", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    if (value.result !== "recorded" && value.result !== "existing")
      throw new Error("runner_ledger_source_freeze_record_invalid");
    return value.result;
  }
  async prepareSourceFreezeMutation(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    serviceId: string;
    latestSuccessfulDeployId: string;
    observedAt: string;
    declaredServiceIds: readonly string[];
    beforeSuspended: boolean;
  }): Promise<boolean> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/source-freeze-preparations`,
      { method: "POST", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    if (typeof value.mutationRequired !== "boolean")
      throw new Error("runner_ledger_source_freeze_prepare_invalid");
    return value.mutationRequired;
  }
  async completeSourceFreeze(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    declaredServiceIds: readonly string[];
    observedAt: string;
  }): Promise<"recorded" | "existing"> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/source-freeze-completion`,
      { method: "POST", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    if (value.result !== "recorded" && value.result !== "existing")
      throw new Error("runner_ledger_source_freeze_complete_invalid");
    return value.result;
  }
  async verifyFinalAuthority(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    expectedReceiptSha256: string;
    activationReceipt: ActivationReceipt;
  }): Promise<boolean> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/verify-final-authority`,
      { method: "POST", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    if (typeof value.verified !== "boolean")
      throw new Error("runner_ledger_final_authority_response_invalid");
    return value.verified;
  }
  async reconcileRollout(rolloutId: string): Promise<{
    state:
      | "pre_activation_compensated"
      | "activated_forward_only"
      | "activation_uncertain_forward_only";
    sourceEligible: boolean;
    sourceAclRestored: boolean;
    sourceServicesResumed: boolean;
    openRunnerJobs: 0;
  }> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(rolloutId)}/reconcile`,
      { method: "POST", body: "{}" },
    )) as Record<string, unknown>;
    const state =
      value.state === "activated"
        ? "activated_forward_only"
        : value.state === "forward_repair_required"
          ? "activation_uncertain_forward_only"
          : value.state;
    if (
      ![
        "pre_activation_compensated",
        "activated_forward_only",
        "activation_uncertain_forward_only",
      ].includes(String(state)) ||
      value.openRunnerJobs !== 0 ||
      (state === "pre_activation_compensated"
        ? value.sourceEligible !== true ||
          value.sourceAclRestored !== true ||
          value.sourceServicesResumed !== true
        : value.sourceEligible !== false ||
          value.sourceAclRestored !== false ||
          value.sourceServicesResumed !== false)
    )
      throw new Error("runner_ledger_rollout_reconciliation_invalid");
    return { ...value, state } as {
      state:
        | "pre_activation_compensated"
        | "activated_forward_only"
        | "activation_uncertain_forward_only";
      sourceEligible: boolean;
      sourceAclRestored: boolean;
      sourceServicesResumed: boolean;
      openRunnerJobs: 0;
    };
  }
}

/** Triggers the separately credentialed provider-side observer by job identity. */
export class AuthenticatedProviderWitnessAdapter {
  private readonly fetchImpl: RenderFetch;
  constructor(
    private readonly origin: string,
    private readonly token: string,
    fetchImpl: RenderFetch = fetch,
  ) {
    if (!origin.startsWith("https://") || !token)
      throw new Error("runner_witness_configuration_invalid");
    const http = new BoundedProviderHttpClient(fetchImpl);
    this.fetchImpl = (url, init) => http.request("runner_witness", url, init);
  }

  async observe(jobId: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.origin.replace(/\/$/u, "")}/v1/runner-jobs/${encodeURIComponent(jobId)}/cleanup-observation`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    if (!response.ok)
      throw new Error(`runner_witness_request_failed:${response.status}`);
  }
}
