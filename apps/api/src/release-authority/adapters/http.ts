import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  ProviderAuthorityRequest,
  RunnerIdentity,
  StepObservation,
} from "@reviewrouter/features-release-rollout";
import type {
  PersistRunnerRegistrationInput,
  ProvisioningIntent,
  RolloutBinding,
  PersistedJob,
} from "../domain/model.js";
import type {
  ProviderAuthorityDecisionService,
  ReleaseAuthorityService,
  ReleaseRolloutReconciliationService,
  ReleaseServiceTransitionService,
  RunnerOperationsService,
} from "../application/services.js";
export type ReleaseRolloutLedgerRouteDependencies = {
  authority: ReleaseAuthorityService;
  runnerOperations: RunnerOperationsService;
  reconciliation: ReleaseRolloutReconciliationService;
  serviceTransition?: ReleaseServiceTransitionService;
  providerAuthority?: ProviderAuthorityDecisionService;
  providerAuthorityTokenSha256?: string;
  controlTokenSha256: string;
};

export type ReleaseControlRouteDependencies =
  ReleaseRolloutLedgerRouteDependencies;

function authorize(request: FastifyRequest, expected: string): void {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const actual = createHash("sha256").update(token).digest();
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    expectedBuffer.length !== actual.length ||
    !timingSafeEqual(actual, expectedBuffer)
  )
    throw Object.assign(new Error("release_rollout_ledger_unauthorized"), {
      statusCode: 401,
    });
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(new Error("release_rollout_ledger_request_invalid"), {
      statusCode: 400,
    });
  return value as Record<string, unknown>;
};
const invalidRegistrationRequest = (): never => {
  throw Object.assign(
    new Error("release_runner_registration_request_invalid"),
    {
      statusCode: 400,
    },
  );
};
const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
};
const nonemptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const registrationRequest = (
  value: unknown,
): PersistRunnerRegistrationInput => {
  const body = record(value);
  if (
    !exactKeys(body, [
      "rolloutId",
      "lifecycle",
      "workflowJobId",
      "registration",
    ]) ||
    !nonemptyString(body.rolloutId) ||
    (body.lifecycle !== "role" && body.lifecycle !== "cutover") ||
    !nonemptyString(body.workflowJobId)
  )
    return invalidRegistrationRequest();
  const registration = record(body.registration);
  if (
    !exactKeys(registration, [
      "runnerId",
      "runnerGroupId",
      "labels",
      "uniqueLabel",
      "workFolder",
    ]) ||
    !Number.isSafeInteger(registration.runnerId) ||
    Number(registration.runnerId) <= 0 ||
    !Number.isSafeInteger(registration.runnerGroupId) ||
    Number(registration.runnerGroupId) <= 0 ||
    !Array.isArray(registration.labels) ||
    registration.labels.length === 0 ||
    registration.labels.length > 32 ||
    registration.labels.some(
      (label) =>
        typeof label !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(label),
    ) ||
    typeof registration.uniqueLabel !== "string" ||
    !/^rr-[A-Za-z0-9][A-Za-z0-9._-]{1,125}$/u.test(registration.uniqueLabel) ||
    !registration.labels.includes(registration.uniqueLabel) ||
    typeof registration.workFolder !== "string" ||
    !/^_work\/rr-[A-Za-z0-9][A-Za-z0-9._-]{1,125}$/u.test(
      registration.workFolder,
    )
  )
    return invalidRegistrationRequest();
  return {
    rolloutId: body.rolloutId,
    lifecycle: body.lifecycle,
    workflowJobId: body.workflowJobId,
    registration: {
      runnerId: Number(registration.runnerId),
      runnerGroupId: Number(registration.runnerGroupId),
      labels: Object.freeze([...registration.labels] as string[]),
      uniqueLabel: registration.uniqueLabel,
      workFolder: registration.workFolder,
    },
  };
};
export async function registerReleaseRolloutLedgerRoutes(
  app: FastifyInstance,
  dependencies: ReleaseRolloutLedgerRouteDependencies,
): Promise<void> {
  const control = async (request: FastifyRequest) =>
    authorize(request, dependencies.controlTokenSha256);
  const serviceTransition = (): ReleaseServiceTransitionService => {
    if (!dependencies.serviceTransition)
      throw Object.assign(new Error("release_service_transition_unavailable"), {
        statusCode: 503,
      });
    return dependencies.serviceTransition;
  };
  app.post(
    "/v1/service-transitions",
    { preHandler: control },
    async (request) => ({
      result: await serviceTransition().begin(record(request.body) as never),
    }),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/service-transitions/:rolloutId/checkpoints",
    { preHandler: control },
    async (request) => ({
      checkpoint: await serviceTransition().append({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as never),
    }),
  );
  app.get<{ Params: { rolloutId: string } }>(
    "/v1/service-transitions/:rolloutId/contract",
    { preHandler: control },
    async (request) =>
      serviceTransition().readContract(request.params.rolloutId),
  );
  app.get<{ Params: { rolloutId: string } }>(
    "/v1/service-transitions/:rolloutId/checkpoints",
    { preHandler: control },
    async (request) => serviceTransition().read(request.params.rolloutId),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/service-transitions/:rolloutId/complete",
    { preHandler: control },
    async (request, reply) => {
      await serviceTransition().complete({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as never);
      return reply.code(204).send();
    },
  );
  app.post("/v1/rollouts/claim", { preHandler: control }, async (request) => ({
    result: await dependencies.authority.claim(
      record(request.body) as RolloutBinding,
    ),
  }));
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/cas",
    { preHandler: control },
    async (request) => ({
      changed: await dependencies.authority.cas({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as never),
    }),
  );
  app.put<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/activation-uncertain",
    { preHandler: control },
    async (request) => ({
      marked: await dependencies.authority.markUncertain({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as RolloutBinding),
    }),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/target-switch-fence",
    { preHandler: control },
    async (request) => {
      const fence = await dependencies.authority.fenceTargetSwitch({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as never);
      return fence ? { changed: true, fence } : { changed: false };
    },
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/activation-authorization",
    { preHandler: control },
    async (request) => {
      const body = record(request.body);
      const authorization = await dependencies.authority.authorizeAndInstall({
        ...body,
        rolloutId: request.params.rolloutId,
      } as never);
      return { authorization };
    },
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/activation-finalize",
    { preHandler: control },
    async (request) => ({
      changed: await dependencies.authority.finalize(
        record(request.body) as never,
      ),
    }),
  );
  app.get<{
    Params: { rolloutId: string };
    Querystring: {
      source_system_identifier: string;
      target_system_identifier: string;
    };
  }>(
    "/v1/rollouts/:rolloutId/activation-state",
    { preHandler: control },
    async (request) => ({
      state: await dependencies.authority.state({
        rolloutId: request.params.rolloutId,
        sourceSystemIdentifier: request.query.source_system_identifier,
        targetSystemIdentifier: request.query.target_system_identifier,
      }),
    }),
  );
  app.get<{
    Params: { rolloutId: string };
    Querystring: {
      source_system_identifier: string;
      target_system_identifier: string;
    };
  }>(
    "/v1/rollouts/:rolloutId/authority-state",
    { preHandler: control },
    async (request) => ({
      state: await dependencies.authority.authorityState({
        rolloutId: request.params.rolloutId,
        sourceSystemIdentifier: request.query.source_system_identifier,
        targetSystemIdentifier: request.query.target_system_identifier,
      }),
    }),
  );
  app.get<{
    Params: { rolloutId: string };
    Querystring: {
      source_system_identifier: string;
      target_system_identifier: string;
    };
  }>(
    "/v1/rollouts/:rolloutId/compensation-checkpoint",
    { preHandler: control },
    async (request) =>
      dependencies.authority.compensationCheckpoint({
        rolloutId: request.params.rolloutId,
        sourceSystemIdentifier: request.query.source_system_identifier,
        targetSystemIdentifier: request.query.target_system_identifier,
      }),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/verify-final-authority",
    { preHandler: control },
    async (request) => ({
      verified: await dependencies.authority.verifyFinalAuthority({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as never),
    }),
  );
  app.post(
    "/v1/runner-jobs/intents",
    { preHandler: control },
    async (request) => ({
      result: await dependencies.runnerOperations.persistIntent(
        record(request.body) as ProvisioningIntent,
      ),
    }),
  );
  app.get<{ Querystring: { rollout_id: string } }>(
    "/v1/runner-jobs/intents",
    { preHandler: control },
    async (request) =>
      dependencies.runnerOperations.listIntents(request.query.rollout_id),
  );
  app.put<{ Params: { intentId: string } }>(
    "/v1/runner-jobs/intents/:intentId/outcome",
    { preHandler: control },
    async (request, reply) => {
      await dependencies.runnerOperations.recordIntentOutcome({
        ...record(request.body),
        intentId: request.params.intentId,
      } as never);
      return reply.code(204).send();
    },
  );
  app.post(
    "/v1/runner-jobs",
    { preHandler: control },
    async (request, reply) => {
      await dependencies.runnerOperations.persistJob(
        record(request.body) as PersistedJob,
      );
      return reply.code(204).send();
    },
  );
  app.get<{
    Querystring: {
      rollout_id: string;
      state?: string;
      lifecycle?: "role" | "cutover";
    };
  }>("/v1/runner-jobs", { preHandler: control }, async (request) =>
    request.query.lifecycle
      ? dependencies.runnerOperations.currentRunner(
          request.query.rollout_id,
          request.query.lifecycle,
        )
      : dependencies.runnerOperations.listOpenJobs(request.query.rollout_id),
  );
  app.get<{
    Querystring: { rollout_id: string; lifecycle: "role" | "cutover" };
  }>("/v1/runner-jobs/current", { preHandler: control }, async (request) =>
    dependencies.runnerOperations.currentRunner(
      request.query.rollout_id,
      request.query.lifecycle,
    ),
  );
  app.put<{ Params: { jobId: string } }>(
    "/v1/runner-jobs/:jobId/identity",
    { preHandler: control },
    async (request, reply) => {
      const body = record(request.body);
      await dependencies.runnerOperations.persistIdentity(
        request.params.jobId,
        body.identity as RunnerIdentity,
        body.observation as StepObservation,
      );
      return reply.code(204).send();
    },
  );
  app.put<{ Params: { jobId: string } }>(
    "/v1/runner-jobs/:jobId/terminal",
    { preHandler: control },
    async (request, reply) => {
      await dependencies.runnerOperations.markTerminal(
        request.params.jobId,
        record(request.body).observation as StepObservation,
      );
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { jobId: string } }>(
    "/v1/runner-jobs/:jobId/cleanup-observation",
    { preHandler: control },
    async (request) =>
      dependencies.runnerOperations.cleanupObservation(request.params.jobId),
  );
  app.get<{ Params: { jobId: string } }>(
    "/v1/runner-jobs/:jobId/cleanup-witness",
    { preHandler: control },
    async (request) =>
      dependencies.runnerOperations.cleanupWitness(request.params.jobId),
  );
  app.get<{
    Querystring: { rollout_id: string; lifecycle: "role" | "cutover" };
  }>(
    "/v1/runner-jobs/terminal-cleanup-fact",
    { preHandler: control },
    async (request) =>
      dependencies.runnerOperations.terminalCleanupFact(
        request.query.rollout_id,
        request.query.lifecycle,
      ),
  );
  app.post(
    "/v1/runner-jobs/registration",
    { preHandler: control },
    async (request, reply) => {
      await dependencies.runnerOperations.persistRegistration(
        registrationRequest(request.body),
      );
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/reconcile",
    { preHandler: control },
    async (request) =>
      dependencies.reconciliation.reconcile(request.params.rolloutId),
  );
  if (
    dependencies.providerAuthority &&
    dependencies.providerAuthorityTokenSha256
  )
    app.post(
      "/v1/provider-authority/decisions",
      {
        preHandler: async (request) =>
          authorize(request, dependencies.providerAuthorityTokenSha256!),
      },
      async (request) => {
        try {
          return await dependencies.providerAuthority!.decide(
            record(request.body) as unknown as ProviderAuthorityRequest,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (
            (error as { statusCode?: unknown })?.statusCode === 409 ||
            /provider authority (?:binding|receipt|state|replay) (?:denied|conflict)/u.test(
              message,
            )
          )
            throw Object.assign(
              new Error("provider_authority_decision_denied"),
              {
                statusCode: 409,
              },
            );
          throw error;
        }
      },
    );
}

export async function registerReleaseControlRoutes(
  app: FastifyInstance,
  dependencies: ReleaseControlRouteDependencies,
): Promise<void> {
  await registerReleaseRolloutLedgerRoutes(app, {
    ...dependencies,
  });
}
