import type {
  ServiceTransitionCheckpoint,
  ServiceTransitionLedger,
} from "@reviewrouter/features-release-rollout";

type BeginRequest = Parameters<ServiceTransitionLedger["begin"]>[0];
type AppendRequest = Omit<ServiceTransitionCheckpoint, "sequence">;

export class ServiceTransitionRequestValidationError extends Error {
  readonly statusCode = 400;

  constructor() {
    super("release_service_transition_request_invalid");
    this.name = "ServiceTransitionRequestValidationError";
  }
}

const invalid = (): never => {
  throw new ServiceTransitionRequestValidationError();
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
};
const exact = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
};
const boundedString = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const timestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};
const stringArray = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is string[] =>
  Array.isArray(value) &&
  value.length >= minimum &&
  value.length <= maximum &&
  value.every((item) => boundedString(item)) &&
  new Set(value).size === value.length;

const sourceContractKeys = [
  "serviceId",
  "ownerId",
  "type",
  "runtime",
  "repository",
  "branch",
  "rootDir",
  "sourceCommitSha",
  "buildCommand",
  "startCommand",
  "preDeployCommand",
  "healthCheckPath",
  "region",
  "plan",
  "maxShutdownDelaySeconds",
  "autoDeploy",
  "databaseEnvKey",
  "databaseRole",
  "sourceEnvSha256",
  "sourceEnvKeysSha256",
  "serviceContractSha256",
] as const;

const validSourceContract = (value: unknown): boolean => {
  const item = record(value);
  return (
    exact(item, sourceContractKeys) &&
    boundedString(item.serviceId) &&
    boundedString(item.ownerId) &&
    (item.type === "web_service" || item.type === "background_worker") &&
    item.runtime === "node" &&
    boundedString(item.repository, 2048) &&
    boundedString(item.branch) &&
    typeof item.rootDir === "string" &&
    item.rootDir.length <= 512 &&
    typeof item.sourceCommitSha === "string" &&
    /^[a-f0-9]{40}$/u.test(item.sourceCommitSha) &&
    typeof item.buildCommand === "string" &&
    item.buildCommand.length <= 4096 &&
    boundedString(item.startCommand, 4096) &&
    typeof item.preDeployCommand === "string" &&
    item.preDeployCommand.length <= 4096 &&
    (item.healthCheckPath === null ||
      (typeof item.healthCheckPath === "string" &&
        item.healthCheckPath.length <= 2048)) &&
    boundedString(item.region) &&
    boundedString(item.plan) &&
    Number.isSafeInteger(item.maxShutdownDelaySeconds) &&
    Number(item.maxShutdownDelaySeconds) >= 0 &&
    item.autoDeploy === "no" &&
    boundedString(item.databaseEnvKey) &&
    boundedString(item.databaseRole) &&
    digest(item.sourceEnvSha256) &&
    digest(item.sourceEnvKeysSha256) &&
    digest(item.serviceContractSha256)
  );
};

const targetContractKeys = [
  "serviceId",
  "imageUrl",
  "removeKeys",
  "environmentSha256",
  "serviceContractSha256",
] as const;

const validTargetContract = (value: unknown): boolean => {
  const item = record(value);
  return (
    exact(item, targetContractKeys) &&
    boundedString(item.serviceId) &&
    boundedString(item.imageUrl, 2048) &&
    stringArray(item.removeKeys, 0, 128) &&
    digest(item.environmentSha256) &&
    digest(item.serviceContractSha256)
  );
};

export function serviceTransitionBeginRequest(value: unknown): BeginRequest {
  const body = record(value);
  const sourceManifest = record(body.sourceManifest);
  const services = sourceManifest.services;
  const serviceIds = body.serviceIds;
  const targetContracts = body.targetContracts;
  if (
    !exact(body, [
      "rolloutId",
      "manifestSha256",
      "targetContractSha256",
      "serviceIds",
      "sourceManifest",
      "targetContracts",
    ]) ||
    !boundedString(body.rolloutId) ||
    !digest(body.manifestSha256) ||
    !digest(body.targetContractSha256) ||
    !stringArray(serviceIds, 3, 3) ||
    !exact(sourceManifest, [
      "schemaVersion",
      "rolloutId",
      "services",
      "manifestSha256",
    ]) ||
    sourceManifest.schemaVersion !== "reviewrouter.render-source-recovery.v1" ||
    sourceManifest.rolloutId !== body.rolloutId ||
    sourceManifest.manifestSha256 !== body.manifestSha256 ||
    !Array.isArray(services) ||
    services.length !== 3 ||
    !services.every(validSourceContract) ||
    !Array.isArray(targetContracts) ||
    targetContracts.length !== 3 ||
    !targetContracts.every(validTargetContract) ||
    services.some(
      (service, index) =>
        record(service).serviceId !== serviceIds[index] ||
        record(targetContracts[index]).serviceId !== serviceIds[index],
    )
  )
    return invalid();
  return body as BeginRequest;
}

const steps = new Set<ServiceTransitionCheckpoint["step"]>([
  "recovery_intent",
  "suspend_intent",
  "suspended",
  "target_config_intent",
  "target_configured",
  "target_env_intent",
  "target_env_applied",
  "target_deploy_intent",
  "target_deployed",
  "target_verified",
  "restore_config_intent",
  "source_config_restored",
  "restore_env_intent",
  "source_env_restored",
  "restore_deploy_intent",
  "source_deployed",
  "source_verified",
  "source_acl_restored",
  "source_resumed",
]);

export function serviceTransitionAppendRequest(
  value: unknown,
  rolloutId: string,
): AppendRequest {
  const body = record(value);
  const required = [
    "manifestSha256",
    "targetContractSha256",
    "serviceId",
    "step",
  ];
  if (
    !boundedString(rolloutId) ||
    !exact(body, required, [
      "deployId",
      "observedContractSha256",
      "observedEnvSha256",
      "intentAt",
    ]) ||
    !digest(body.manifestSha256) ||
    !digest(body.targetContractSha256) ||
    !boundedString(body.serviceId) ||
    !steps.has(body.step as ServiceTransitionCheckpoint["step"])
  )
    return invalid();

  const facts = Object.keys(body).filter((key) => !required.includes(key));
  const exactFacts = (...expected: string[]) =>
    facts.length === expected.length &&
    expected.every((key) => facts.includes(key));
  const valid =
    (body.step === "restore_deploy_intent" &&
      exactFacts("intentAt") &&
      timestamp(body.intentAt)) ||
    ((body.step === "target_deployed" || body.step === "source_deployed") &&
      exactFacts("deployId") &&
      boundedString(body.deployId)) ||
    ((body.step === "target_verified" || body.step === "source_verified") &&
      exactFacts("deployId", "observedContractSha256", "observedEnvSha256") &&
      boundedString(body.deployId) &&
      digest(body.observedContractSha256) &&
      digest(body.observedEnvSha256)) ||
    ((body.step === "target_env_applied" ||
      body.step === "source_env_restored") &&
      exactFacts("observedEnvSha256") &&
      digest(body.observedEnvSha256)) ||
    (![
      "restore_deploy_intent",
      "target_deployed",
      "source_deployed",
      "target_verified",
      "source_verified",
      "target_env_applied",
      "source_env_restored",
    ].includes(String(body.step)) &&
      exactFacts());
  if (!valid) return invalid();
  return { ...body, rolloutId } as AppendRequest;
}
