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
  | Readonly<{ kind: "source_revision"; revision: string }>
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
}>;

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
