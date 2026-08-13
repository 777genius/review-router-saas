#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  AuthenticatedRunnerLedgerAdapter,
  assertGenerationIdentity,
  HttpProviderAuthorityDecisionAdapter,
  parseRolloutPhase,
  PostgreSqlGenerationAdapter,
  RedactedProcessCommandAdapter,
  ReleaseCompensationReconciliationUseCase,
  RenderProviderFreezeAdapter,
  RenderTransactionalServicesAdapter,
  TransactionalServiceCutover,
  type ProtectedSourceEnvironment,
  type TargetServiceContract,
  type ReleaseRollout,
} from "../packages/features/release-rollout/src/index";
import { parseCompensationSourceWriterServiceIds } from "./reconcile-private-pg17-compensation-config";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_reconcile_required:${name}`);
  return value;
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function parseInitialRolloutArtifact(
  value: unknown,
  expectedRolloutId: string,
): ReleaseRollout {
  const artifact = object(value);
  const candidate = object(artifact?.rollout);
  if (!artifact || !candidate || Object.keys(artifact).length !== 1)
    throw new Error("private_pg17_reconcile_artifact_invalid");
  if (candidate.schemaVersion !== 2)
    throw new Error("private_pg17_reconcile_schema_version_unsupported");
  if (candidate.rolloutId !== expectedRolloutId)
    throw new Error("private_pg17_reconcile_rollout_mismatch");

  const execution = object(candidate.execution);
  const source = object(candidate.source);
  const target = object(candidate.target);
  if (
    typeof candidate.expectedCommitSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(candidate.expectedCommitSha) ||
    !execution ||
    typeof execution.runId !== "string" ||
    !/^[1-9][0-9]*$/u.test(execution.runId) ||
    !Number.isSafeInteger(execution.runAttempt) ||
    !source ||
    !target ||
    !Array.isArray(candidate.receipts) ||
    typeof candidate.activated !== "boolean" ||
    typeof candidate.activationUncertain !== "boolean" ||
    typeof candidate.sourcePermanentlyIneligible !== "boolean"
  )
    throw new Error("private_pg17_reconcile_rollout_invalid");

  try {
    parseRolloutPhase(candidate.phase);
    assertGenerationIdentity(source as unknown as ReleaseRollout["source"], 16);
    assertGenerationIdentity(target as unknown as ReleaseRollout["target"], 17);
  } catch {
    throw new Error("private_pg17_reconcile_rollout_invalid");
  }
  return candidate as unknown as ReleaseRollout;
}

export async function reconcilePrivatePg17Compensation(): Promise<void> {
  const rollout = parseInitialRolloutArtifact(
    JSON.parse(
      readFileSync(required("REVIEW_ROUTER_INITIAL_ROLLOUT_FILE"), "utf8"),
    ) as unknown,
    required("REVIEW_ROUTER_ROLLOUT_ID"),
  );
  const ledger = new AuthenticatedRunnerLedgerAdapter(
    required("REVIEW_ROUTER_RUNNER_LEDGER_URL"),
    required("REVIEW_ROUTER_RUNNER_LEDGER_TOKEN"),
  );
  const authority = new HttpProviderAuthorityDecisionAdapter(
    required("REVIEW_ROUTER_PROVIDER_AUTHORITY_URL"),
    required("REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN"),
  );
  const database = new PostgreSqlGenerationAdapter(
    new RedactedProcessCommandAdapter(),
  );
  const durableContract = await ledger.readContract(rollout.rolloutId);
  const sourceRecoveryManifest = durableContract?.sourceManifest;
  const persistedTargets = durableContract?.targetContracts;
  const sourceUrls = JSON.parse(
    required("REVIEW_ROUTER_SOURCE_RECONNECT_URLS_JSON"),
  ) as Record<string, string>;
  const sourceWitness = required("REVIEW_ROUTER_SOURCE_RECOVERY_WITNESS");
  const protectedSourceEnvironment = sourceRecoveryManifest
    ? (Object.fromEntries(
        sourceRecoveryManifest.services.map((service) => [
          service.serviceId,
          {
            DATABASE_URL: sourceUrls[service.databaseRole] ?? "",
            REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: sourceWitness,
          },
        ]),
      ) as ProtectedSourceEnvironment)
    : {};
  const placeholderDelta = {
    DATABASE_URL: "durable-hash-only",
    REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "durable-hash-only",
    REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA: "durable-hash-only",
    REVIEW_ROUTER_RUNTIME_ROLLOUT_ID: "durable-hash-only",
    REVIEW_ROUTER_RUNTIME_ROLLOUT_STARTED_AT: "durable-hash-only",
  };
  const targetServiceContracts = persistedTargets?.map((item) => ({
    ...item,
    environmentDelta: placeholderDelta,
  })) as TargetServiceContract[] | undefined;
  const serviceTransition = new TransactionalServiceCutover(
    ledger,
    new RenderTransactionalServicesAdapter(
      required("RENDER_TARGET_SWITCH_API_KEY"),
    ),
  );
  const checkpoints = await ledger.read(rollout.rolloutId);
  const sourceWriterServiceIds = parseCompensationSourceWriterServiceIds(
    required("REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS"),
  );
  if (
    sourceWriterServiceIds.length !== 3 ||
    new Set(sourceWriterServiceIds).size !== 3 ||
    (sourceRecoveryManifest &&
      [...sourceWriterServiceIds].sort().join("\0") !==
        sourceRecoveryManifest.services
          .map((item) => item.serviceId)
          .sort()
          .join("\0"))
  )
    throw new Error("private_pg17_reconcile_service_scope_invalid");
  if ((checkpoints.length === 0) !== (durableContract === null))
    throw new Error("private_pg17_reconcile_transition_state_inconsistent");
  const frozenSource = new RenderProviderFreezeAdapter();
  if (
    checkpoints.length > 0 &&
    (!sourceRecoveryManifest ||
      !targetServiceContracts ||
      sourceRecoveryManifest.services.some(
        (service) => !sourceUrls[service.databaseRole],
      ))
  )
    throw new Error("private_pg17_reconcile_transition_contract_missing");
  let sourceServicesRestored = false;
  const useCase = new ReleaseCompensationReconciliationUseCase({
    authority,
    ledger,
    compensateDatabase: async () => {
      if (checkpoints.length > 0 && !sourceServicesRestored) {
        await serviceTransition.recover({
          source: sourceRecoveryManifest!,
          protectedEnvironment: protectedSourceEnvironment,
          target: targetServiceContracts!,
        });
        sourceServicesRestored = true;
      }
      return database.compensateSource({
        adminUrl: required("REVIEW_ROUTER_SOURCE_DATABASE_URL"),
        source: rollout.source,
        reconnectUrls: JSON.parse(
          required("REVIEW_ROUTER_SOURCE_RECONNECT_URLS_JSON"),
        ) as Record<string, string>,
      });
    },
    provider: {
      compensateAndObserve: async ({ decision, databaseWitness }) => {
        if (
          decision.decision !== "allow" ||
          decision.operation !== "resume_source" ||
          databaseWitness.sourceWritesRestored !== true
        )
          throw new Error("private_pg17_service_recovery_authority_invalid");
        if (checkpoints.length === 0)
          return frozenSource.compensateAndObserve({
            apiKey: required("RENDER_SERVICE_SUSPENSION_API_KEY"),
            sourceWriterServiceIds,
            sourceSystemIdentifier: rollout.source.systemIdentifier,
            decision,
            databaseWitness,
          });
        await serviceTransition.finalizeAuthorizedSourceRecovery({
          source: sourceRecoveryManifest!,
          protectedEnvironment: protectedSourceEnvironment,
          target: targetServiceContracts!,
          restoreSourceWritesAndVerify: async () => undefined,
        });
        const restored = await ledger.read(rollout.rolloutId);
        return {
          serviceIds: sourceRecoveryManifest!.services.map(
            (item) => item.serviceId,
          ),
          deployIds: sourceRecoveryManifest!.services.map((service) => {
            const deployId = [...restored]
              .reverse()
              .find(
                (item) =>
                  item.serviceId === service.serviceId &&
                  item.step === "source_verified",
              )?.deployId;
            if (!deployId)
              throw new Error("private_pg17_source_deploy_checkpoint_missing");
            return deployId;
          }),
          observedAt: new Date().toISOString(),
          resumed: true,
        };
      },
    },
  });
  const result = await useCase.execute(rollout);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await reconcilePrivatePg17Compensation();
