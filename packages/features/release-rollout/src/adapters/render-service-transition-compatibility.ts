import { createHash } from "node:crypto";
import type {
  JsonValue,
  SourceRecoveryManifest,
  SourceServiceSnapshot,
  TargetServiceRelease,
} from "../domain/service-transition";
import { sourceRecoveryManifestSha256 } from "../domain/service-transition";

export const RENDER_SOURCE_CONFIGURATION_FORMAT = "render.service.v1";
export const RENDER_SOURCE_RECOVERY_FORMAT =
  "reviewrouter.render-source-recovery.v1";

export type RenderSourceServiceContractV1 = Readonly<{
  serviceId: string;
  ownerId: string;
  type: "web_service" | "background_worker";
  runtime: "node";
  repository: string;
  branch: string;
  rootDir: string;
  sourceCommitSha: string;
  buildCommand: string;
  startCommand: string;
  preDeployCommand: string;
  healthCheckPath: string | null;
  region: string;
  plan: string;
  maxShutdownDelaySeconds: number;
  /** Added to newly captured v1 values; absent legacy evidence remains readable. */
  numInstances?: number;
  autoDeploy: "no";
  databaseEnvKey: string;
  databaseRole: string;
  sourceEnvSha256: string;
  sourceEnvKeysSha256: string;
  serviceContractSha256: string;
}>;

export type RenderSourceRecoveryManifestV1 = Readonly<{
  schemaVersion: typeof RENDER_SOURCE_RECOVERY_FORMAT;
  rolloutId: string;
  services: readonly RenderSourceServiceContractV1[];
  manifestSha256: string;
}>;

export type RenderTargetServiceContractV1 = Readonly<{
  serviceId: string;
  imageUrl: string;
  removeKeys: readonly string[];
  environmentSha256: string;
  serviceContractSha256: string;
}>;

const sha256 = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

export const renderSourceServiceContractSha256 = (
  value: Omit<RenderSourceServiceContractV1, "serviceContractSha256">,
): string =>
  sha256({
    serviceId: value.serviceId,
    ownerId: value.ownerId,
    type: value.type,
    runtime: value.runtime,
    repository: value.repository,
    branch: value.branch,
    rootDir: value.rootDir,
    buildCommand: value.buildCommand,
    startCommand: value.startCommand,
    preDeployCommand: value.preDeployCommand,
    healthCheckPath: value.healthCheckPath,
    region: value.region,
    plan: value.plan,
    maxShutdownDelaySeconds: value.maxShutdownDelaySeconds,
    ...(value.numInstances === undefined
      ? {}
      : { numInstances: value.numInstances }),
    autoDeploy: value.autoDeploy,
  });

export const renderSourceRecoveryManifestSha256 = (
  value: Omit<RenderSourceRecoveryManifestV1, "manifestSha256">,
): string => sha256(value);

const configurationPayload = (
  source: RenderSourceServiceContractV1,
): Record<string, JsonValue> => ({
  ownerId: source.ownerId,
  type: source.type,
  runtime: source.runtime,
  repository: source.repository,
  branch: source.branch,
  rootDir: source.rootDir,
  buildCommand: source.buildCommand,
  startCommand: source.startCommand,
  preDeployCommand: source.preDeployCommand,
  healthCheckPath: source.healthCheckPath,
  region: source.region,
  plan: source.plan,
  maxShutdownDelaySeconds: source.maxShutdownDelaySeconds,
  ...(source.numInstances === undefined
    ? {}
    : { numInstances: source.numInstances }),
  autoDeploy: source.autoDeploy,
});

export function fromRenderSourceRecoveryManifestV1(
  manifest: RenderSourceRecoveryManifestV1,
): SourceRecoveryManifest {
  const { manifestSha256, ...unsigned } = manifest;
  if (renderSourceRecoveryManifestSha256(unsigned) !== manifestSha256)
    throw new Error("render_service_transition_manifest_integrity_invalid");
  const neutral = {
    format: manifest.schemaVersion,
    rolloutId: manifest.rolloutId,
    services: manifest.services.map((source) => ({
      serviceId: source.serviceId,
      sourceRevision: source.sourceCommitSha,
      configuration: {
        format: RENDER_SOURCE_CONFIGURATION_FORMAT,
        payload: configurationPayload(source),
        sha256: source.serviceContractSha256,
      },
      databaseEnvKey: source.databaseEnvKey,
      databaseRole: source.databaseRole,
      sourceEnvironmentSha256: source.sourceEnvSha256,
      sourceEnvironmentKeysSha256: source.sourceEnvKeysSha256,
    })),
  };
  return {
    ...neutral,
    contentSha256: sourceRecoveryManifestSha256(neutral),
    integrity: "adapter_verified_legacy",
    manifestSha256: manifest.manifestSha256,
  };
}

export const renderSourceConfigurationV1 = (
  source: SourceServiceSnapshot,
): Omit<
  RenderSourceServiceContractV1,
  | "serviceId"
  | "sourceCommitSha"
  | "databaseEnvKey"
  | "databaseRole"
  | "sourceEnvSha256"
  | "sourceEnvKeysSha256"
  | "serviceContractSha256"
> => {
  if (source.configuration.format !== RENDER_SOURCE_CONFIGURATION_FORMAT)
    throw new Error("render_service_transition_configuration_format_invalid");
  const payload = source.configuration.payload;
  if (
    typeof payload.ownerId !== "string" ||
    (payload.type !== "web_service" && payload.type !== "background_worker") ||
    payload.runtime !== "node" ||
    typeof payload.repository !== "string" ||
    typeof payload.branch !== "string" ||
    typeof payload.rootDir !== "string" ||
    typeof payload.buildCommand !== "string" ||
    typeof payload.startCommand !== "string" ||
    typeof payload.preDeployCommand !== "string" ||
    (payload.healthCheckPath !== null &&
      typeof payload.healthCheckPath !== "string") ||
    typeof payload.region !== "string" ||
    typeof payload.plan !== "string" ||
    typeof payload.maxShutdownDelaySeconds !== "number" ||
    (payload.numInstances !== undefined &&
      typeof payload.numInstances !== "number") ||
    payload.autoDeploy !== "no"
  )
    throw new Error("render_service_transition_configuration_invalid");
  return payload as ReturnType<typeof renderSourceConfigurationV1>;
};

export function toRenderSourceRecoveryManifestV1(
  manifest: SourceRecoveryManifest,
): RenderSourceRecoveryManifestV1 {
  if (manifest.format !== RENDER_SOURCE_RECOVERY_FORMAT)
    throw new Error("render_service_transition_manifest_format_invalid");
  const unsigned: Omit<RenderSourceRecoveryManifestV1, "manifestSha256"> = {
    schemaVersion: RENDER_SOURCE_RECOVERY_FORMAT,
    rolloutId: manifest.rolloutId,
    services: manifest.services.map((source) => {
      const configuration = renderSourceConfigurationV1(source);
      return {
        serviceId: source.serviceId,
        ownerId: configuration.ownerId,
        type: configuration.type,
        runtime: configuration.runtime,
        repository: configuration.repository,
        branch: configuration.branch,
        rootDir: configuration.rootDir,
        sourceCommitSha: source.sourceRevision,
        buildCommand: configuration.buildCommand,
        startCommand: configuration.startCommand,
        preDeployCommand: configuration.preDeployCommand,
        healthCheckPath: configuration.healthCheckPath,
        region: configuration.region,
        plan: configuration.plan,
        maxShutdownDelaySeconds: configuration.maxShutdownDelaySeconds,
        ...(configuration.numInstances === undefined
          ? {}
          : { numInstances: configuration.numInstances }),
        autoDeploy: configuration.autoDeploy,
        databaseEnvKey: source.databaseEnvKey,
        databaseRole: source.databaseRole,
        sourceEnvSha256: source.sourceEnvironmentSha256,
        sourceEnvKeysSha256: source.sourceEnvironmentKeysSha256,
        serviceContractSha256: source.configuration.sha256,
      };
    }),
  };
  if (renderSourceRecoveryManifestSha256(unsigned) !== manifest.manifestSha256)
    throw new Error("render_service_transition_manifest_integrity_invalid");
  return {
    ...unsigned,
    manifestSha256: manifest.manifestSha256,
  };
}

export const toRenderTargetServiceContractV1 = (
  target: Omit<TargetServiceRelease, "environmentDelta">,
): RenderTargetServiceContractV1 => ({
  serviceId: target.serviceId,
  imageUrl: target.artifact.reference,
  removeKeys: target.removeKeys,
  environmentSha256: target.environmentSha256,
  serviceContractSha256: target.configurationSha256,
});

export const fromRenderTargetServiceContractV1 = (
  target: RenderTargetServiceContractV1,
): Omit<TargetServiceRelease, "environmentDelta"> => ({
  serviceId: target.serviceId,
  artifact: { kind: "container_image", reference: target.imageUrl },
  removeKeys: target.removeKeys,
  environmentSha256: target.environmentSha256,
  configurationSha256: target.serviceContractSha256,
});
