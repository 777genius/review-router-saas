import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ServiceConfigurationSnapshot = Readonly<{
  /** Adapter-owned format. Neutral policy treats the payload as opaque. */
  format: string;
  payload: Readonly<Record<string, JsonValue>>;
  sha256: string;
}>;

export type SourceServiceSnapshot = Readonly<{
  serviceId: string;
  sourceRevision: string;
  configuration: ServiceConfigurationSnapshot;
  databaseEnvKey: string;
  databaseRole: string;
  sourceEnvironmentSha256: string;
  sourceEnvironmentKeysSha256: string;
}>;

export type SourceRecoveryManifest = Readonly<{
  /** Adapter/evidence format, retained so persisted contracts can be migrated. */
  format: string;
  rolloutId: string;
  services: readonly SourceServiceSnapshot[];
  /** Provider-neutral integrity over format, rollout identity, and services. */
  contentSha256: string;
  integrity: "canonical" | "adapter_verified_legacy";
  /** Durable evidence identifier; an adapter may preserve a legacy digest. */
  manifestSha256: string;
}>;

export type ProtectedSourceEnvironment = Readonly<
  Record<
    string,
    Readonly<{
      DATABASE_URL: string;
      REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: string;
      REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256: string;
      REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL?: string;
    }>
  >
>;

export type TargetServiceRelease = Readonly<{
  serviceId: string;
  artifact: Readonly<{ kind: "container_image"; reference: string }>;
  environmentDelta: Readonly<Record<string, string>>;
  removeKeys: readonly string[];
  environmentSha256: string;
  configurationSha256: string;
}>;

export type ServiceDeploymentProvenance =
  | Readonly<{
      kind: "source_revision";
      revision: string;
      deploymentId: string;
    }>
  | Readonly<{
      kind: "container_image";
      reference: string;
      deploymentId: string;
    }>;

export type ObservedServiceState = Readonly<{
  serviceId: string;
  suspended: boolean;
  configurationSha256: string;
  environmentSha256: string;
  provenance: ServiceDeploymentProvenance;
  postcondition?: NormalizedServicePostcondition;
}>;

/**
 * Provider-neutral, secret-safe service postcondition.  This is the complete
 * value that is carried from staging to the final online transition; adapters
 * may not substitute a provider response or a partial set of fields for it.
 */
export type NormalizedServicePostcondition = Readonly<{
  serviceId: string;
  ownerId: string;
  serviceType: string;
  suspended: boolean;
  region: string;
  plan: string;
  runtime: "node" | "image";
  image: string | null;
  repository: string | null;
  branch: string | null;
  rootDirectory: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  preDeployCommand: string;
  healthPath: string | null;
  automaticDeployments: false;
  automaticDeployTrigger: "off";
  shutdownDelaySeconds: number;
  instanceCount: number;
  /** SHA-256 over sorted key/value pairs; environment values never leave the adapter. */
  environmentSha256: string;
}>;

export const normalizedServicePostconditionSha256 = (
  value: NormalizedServicePostcondition,
): string => sha256(value);

export const sameNormalizedServicePostcondition = (
  left: NormalizedServicePostcondition,
  right: NormalizedServicePostcondition,
): boolean =>
  normalizedServicePostconditionSha256(left) ===
  normalizedServicePostconditionSha256(right);

export const isNormalizedServicePostcondition = (
  value: unknown,
): value is NormalizedServicePostcondition => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.serviceId === "string" &&
    typeof item.ownerId === "string" &&
    typeof item.serviceType === "string" &&
    typeof item.suspended === "boolean" &&
    typeof item.region === "string" &&
    typeof item.plan === "string" &&
    (item.runtime === "node" || item.runtime === "image") &&
    (item.image === null || typeof item.image === "string") &&
    (item.repository === null || typeof item.repository === "string") &&
    (item.branch === null || typeof item.branch === "string") &&
    (item.rootDirectory === null || typeof item.rootDirectory === "string") &&
    (item.buildCommand === null || typeof item.buildCommand === "string") &&
    (item.startCommand === null || typeof item.startCommand === "string") &&
    typeof item.preDeployCommand === "string" &&
    (item.healthPath === null || typeof item.healthPath === "string") &&
    item.automaticDeployments === false &&
    item.automaticDeployTrigger === "off" &&
    Number.isSafeInteger(item.shutdownDelaySeconds) &&
    Number.isSafeInteger(item.instanceCount) &&
    /^sha256:[a-f0-9]{64}$/u.test(String(item.environmentSha256))
  );
};

const sha256 = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const digest = /^sha256:[a-f0-9]{64}$/u;
const rawSha256 = /^[a-f0-9]{64}$/u;
const witness = /^[A-Za-z0-9_-]{43,256}$/u;
const revision = /^[a-f0-9]{40}$/u;
const pinnedContainerImage =
  /^(?=.{1,2048}$)[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/u;

export const environmentSha256 = (
  values: readonly Readonly<{ key: string; value: string }>[],
): string => sha256(canonicalEnvironment(values));

export const environmentKeysSha256 = (
  values: readonly Readonly<{ key: string; value: string }>[],
): string => sha256(canonicalEnvironment(values).map(({ key }) => key));

export const sourceRecoveryManifestSha256 = (
  value: Pick<SourceRecoveryManifest, "format" | "rolloutId" | "services">,
): string =>
  sha256({
    format: value.format,
    rolloutId: value.rolloutId,
    services: value.services,
  });

const canonicalEnvironment = (
  values: readonly Readonly<{ key: string; value: string }>[],
): readonly Readonly<{ key: string; value: string }>[] => {
  const result = [...values].sort((a, b) => a.key.localeCompare(b.key));
  if (
    result.length === 0 ||
    result.some(
      (item, index) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(item.key) ||
        (index > 0 && result[index - 1]?.key === item.key),
    )
  )
    throw new Error("service_transition_environment_invalid");
  return result;
};

export const targetServiceConfigurationSha256 = (
  value: Pick<
    TargetServiceRelease,
    "serviceId" | "artifact" | "environmentSha256"
  >,
): string =>
  sha256({
    serviceId: value.serviceId,
    runtime: value.artifact.kind,
    artifactReference: value.artifact.reference,
    environmentSha256: value.environmentSha256,
    automaticDeployments: false,
    preDeployCommand: "",
  });

export class ServiceTransitionPolicy {
  constructor(private readonly requiredServiceCount = 3) {
    if (!Number.isSafeInteger(requiredServiceCount) || requiredServiceCount < 1)
      throw new Error("service_transition_policy_invalid");
  }

  validate(
    source: SourceRecoveryManifest,
    protectedEnvironment: ProtectedSourceEnvironment,
    target: readonly TargetServiceRelease[],
  ): string {
    if (
      !source.format ||
      !digest.test(source.contentSha256) ||
      !digest.test(source.manifestSha256) ||
      sourceRecoveryManifestSha256(source) !== source.contentSha256 ||
      (source.integrity === "canonical" &&
        source.manifestSha256 !== source.contentSha256) ||
      source.services.length !== this.requiredServiceCount ||
      target.length !== this.requiredServiceCount
    )
      throw new Error("service_transition_manifest_invalid");
    const sourceIds = source.services.map((item) => item.serviceId);
    if (
      new Set(sourceIds).size !== this.requiredServiceCount ||
      sourceIds.join("\0") !== target.map((item) => item.serviceId).join("\0")
    )
      throw new Error("service_transition_scope_invalid");
    for (const service of source.services) {
      const originals = protectedEnvironment[service.serviceId];
      const requiresEffectAuthority =
        service.databaseRole === "reviewrouter_api" ||
        service.databaseRole === "reviewrouter_web";
      const expectedProtectedKeys = [
        "DATABASE_URL",
        "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
        "REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256",
        ...(requiresEffectAuthority
          ? ["REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL"]
          : []),
      ].sort();
      if (
        !service.serviceId ||
        !revision.test(service.sourceRevision) ||
        !service.configuration.format ||
        !digest.test(service.configuration.sha256) ||
        !digest.test(service.sourceEnvironmentSha256) ||
        !digest.test(service.sourceEnvironmentKeysSha256) ||
        !originals ||
        typeof originals.DATABASE_URL !== "string" ||
        typeof originals.REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS !== "string" ||
        !witness.test(originals.REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS) ||
        !rawSha256.test(
          originals.REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256,
        ) ||
        (requiresEffectAuthority &&
          typeof originals.REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL !==
            "string") ||
        createHash("sha256")
          .update(originals.REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS, "utf8")
          .digest("hex") !==
          originals.REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256 ||
        Object.keys(originals).sort().join("\0") !==
          expectedProtectedKeys.join("\0")
      )
        throw new Error("service_transition_source_contract_invalid");
    }
    for (const service of target) {
      const sourceService = source.services.find(
        (item) => item.serviceId === service.serviceId,
      )!;
      const requiresEffectAuthority =
        sourceService.databaseRole === "reviewrouter_api" ||
        sourceService.databaseRole === "reviewrouter_web";
      const expectedSet = [
        "DATABASE_URL",
        "REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256",
        "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
        "REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA",
        "REVIEW_ROUTER_RUNTIME_ROLLOUT_ID",
        "REVIEW_ROUTER_RUNTIME_ROLLOUT_STARTED_AT",
        "REVIEW_ROUTER_RUNTIME_SERVICE_ID",
        "REVIEW_ROUTER_RUNTIME_DEPLOYMENT_PROVENANCE",
        ...(requiresEffectAuthority
          ? ["REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL"]
          : []),
      ];
      const recoveryWitness =
        service.environmentDelta["REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS"] ??
        "";
      const expectedWitnessSha =
        service.environmentDelta[
          "REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256"
        ] ?? "";
      if (
        service.artifact.kind !== "container_image" ||
        !pinnedContainerImage.test(service.artifact.reference) ||
        service.environmentDelta["REVIEW_ROUTER_RUNTIME_SERVICE_ID"] !==
          service.serviceId ||
        service.environmentDelta[
          "REVIEW_ROUTER_RUNTIME_DEPLOYMENT_PROVENANCE"
        ] !== service.artifact.reference.slice(-64) ||
        !digest.test(service.environmentSha256) ||
        Object.keys(service.environmentDelta).sort().join("\0") !==
          expectedSet.sort().join("\0") ||
        !rawSha256.test(expectedWitnessSha) ||
        !witness.test(recoveryWitness) ||
        createHash("sha256").update(recoveryWitness, "utf8").digest("hex") !==
          expectedWitnessSha ||
        service.removeKeys.length !== 0 ||
        targetServiceConfigurationSha256(service) !==
          service.configurationSha256
      )
        throw new Error("service_transition_target_contract_invalid");
    }
    return sha256(
      target.map(
        ({ serviceId, artifact, environmentSha256, configurationSha256 }) => ({
          serviceId,
          artifact,
          environmentSha256,
          configurationSha256,
        }),
      ),
    );
  }
}
