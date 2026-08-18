import type { RenderService } from "./render-api";
import type { NormalizedServicePostcondition } from "../domain/service-transition";

type SharedContract = Readonly<{
  serviceId: string;
  ownerId: string;
  serviceType: string;
  autoDeploy: "no";
  autoDeployTrigger: "off";
  preDeployCommand: string;
  region: string;
  plan: string;
  maxShutdownDelaySeconds: number;
  numInstances: number;
}>;

export type RenderTargetServiceContract = SharedContract &
  Readonly<{
    runtime: "image";
    imagePath: string;
  }>;

export type RenderSourceServiceContract = SharedContract &
  Readonly<{
    runtime: "node";
    imagePath: null;
    repository: string;
    branch: string;
    rootDir: string;
    buildCommand: string;
    startCommand: string;
    healthCheckPath: string | null;
  }>;

export type RenderServiceContract =
  | RenderTargetServiceContract
  | RenderSourceServiceContract;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

type CanonicalValue =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "value"; value: unknown }>;

const oneCanonicalValue = (
  candidates: readonly Readonly<{ present: boolean; value: unknown }>[],
): CanonicalValue => {
  const present = candidates.filter((candidate) => candidate.present);
  if (present.length === 0) return { kind: "absent" };
  const value = present[0]!.value;
  return present.every((candidate) => candidate.value === value)
    ? { kind: "value", value }
    : { kind: "conflict" };
};

const equalsCanonicalValue = (
  canonical: CanonicalValue,
  expected: unknown,
): boolean => canonical.kind === "value" && canonical.value === expected;

const own = (value: Record<string, unknown>, key: string) => ({
  present: Object.hasOwn(value, key),
  value: value[key],
});

/**
 * Adapter-owned value object for the complete Render service mutation
 * postcondition. Provider omissions, conflicting aliases, and unknown enum
 * values deliberately produce a non-match.
 */
export class RenderServiceContractMatcher {
  constructor(readonly value: RenderServiceContract) {}

  matches(service: RenderService): boolean {
    if (
      service.id !== this.value.serviceId ||
      service.ownerId !== this.value.ownerId ||
      service.type !== this.value.serviceType ||
      service.autoDeploy !== this.value.autoDeploy ||
      service.autoDeployTrigger !== this.value.autoDeployTrigger ||
      !record(service.serviceDetails)
    )
      return false;

    const details = service.serviceDetails;
    const specific = record(details.envSpecificDetails)
      ? details.envSpecificDetails
      : {};
    const runtime = oneCanonicalValue([
      own(details, "runtime"),
      own(specific, "runtime"),
    ]);
    const preDeployCommand = oneCanonicalValue([
      own(details, "preDeployCommand"),
      own(specific, "preDeployCommand"),
    ]);
    if (
      !equalsCanonicalValue(runtime, this.value.runtime) ||
      !equalsCanonicalValue(preDeployCommand, this.value.preDeployCommand) ||
      details.region !== this.value.region ||
      details.plan !== this.value.plan ||
      details.maxShutdownDelaySeconds !== this.value.maxShutdownDelaySeconds ||
      details.numInstances !== this.value.numInstances
    )
      return false;

    if (this.value.runtime === "image") {
      const image = record(service.image) ? service.image : {};
      return equalsCanonicalValue(
        oneCanonicalValue([
          own(service as unknown as Record<string, unknown>, "imagePath"),
          own(image, "imagePath"),
          own(details, "imagePath"),
        ]),
        this.value.imagePath,
      );
    }

    const image = record(service.image) ? service.image : {};
    if (
      oneCanonicalValue([
        own(service as unknown as Record<string, unknown>, "imagePath"),
        own(image, "imagePath"),
        own(details, "imagePath"),
      ]).kind !== "absent"
    )
      return false;

    const healthCheckPath = oneCanonicalValue([
      own(details, "healthCheckPath"),
      own(specific, "healthCheckPath"),
    ]);
    if (
      service.repo !== this.value.repository ||
      service.branch !== this.value.branch ||
      service.rootDir !== this.value.rootDir ||
      specific.buildCommand !== this.value.buildCommand ||
      specific.startCommand !== this.value.startCommand ||
      !equalsCanonicalValue(healthCheckPath, this.value.healthCheckPath)
    )
      return false;

    return true;
  }
}

const optionalCanonical = (
  candidates: readonly Readonly<{ present: boolean; value: unknown }>[],
  kind: "string" | "nullable_string",
): string | null => {
  const value = oneCanonicalValue(candidates);
  if (value.kind === "conflict")
    throw new Error("render_service_postcondition_alias_conflict");
  if (value.kind === "absent" || value.value === null) {
    if (kind === "nullable_string") return null;
    throw new Error("render_service_postcondition_incomplete");
  }
  if (typeof value.value !== "string")
    throw new Error("render_service_postcondition_incomplete");
  return value.value;
};

/** Convert provider-shaped data once at the adapter boundary. */
export const normalizeRenderServicePostcondition = (
  service: RenderService,
  environmentSha256: string,
): NormalizedServicePostcondition => {
  if (!record(service.serviceDetails))
    throw new Error("render_service_postcondition_incomplete");
  const details = service.serviceDetails;
  const specific = record(details.envSpecificDetails)
    ? details.envSpecificDetails
    : {};
  const runtime = optionalCanonical(
    [own(details, "runtime"), own(specific, "runtime")],
    "string",
  );
  const image = optionalCanonical(
    [
      own(service as unknown as Record<string, unknown>, "imagePath"),
      own(record(service.image) ? service.image : {}, "imagePath"),
      own(details, "imagePath"),
    ],
    "nullable_string",
  );
  const buildCommand = optionalCanonical(
    [own(details, "buildCommand"), own(specific, "buildCommand")],
    "nullable_string",
  );
  const startCommand = optionalCanonical(
    [own(details, "startCommand"), own(specific, "startCommand")],
    "nullable_string",
  );
  const preDeployCommand = optionalCanonical(
    [own(details, "preDeployCommand"), own(specific, "preDeployCommand")],
    "string",
  );
  const healthPath = optionalCanonical(
    [own(details, "healthCheckPath"), own(specific, "healthCheckPath")],
    "nullable_string",
  );
  if (
    (runtime !== "node" && runtime !== "image") ||
    preDeployCommand === null ||
    (runtime === "image" && image === null) ||
    (runtime === "node" && image !== null) ||
    service.autoDeploy !== "no" ||
    service.autoDeployTrigger !== "off" ||
    typeof details.region !== "string" ||
    typeof details.plan !== "string" ||
    typeof details.maxShutdownDelaySeconds !== "number" ||
    typeof details.numInstances !== "number" ||
    !Number.isSafeInteger(details.numInstances) ||
    !Number.isSafeInteger(details.maxShutdownDelaySeconds) ||
    !/^sha256:[a-f0-9]{64}$/u.test(environmentSha256)
  )
    throw new Error("render_service_postcondition_incomplete");
  return Object.freeze({
    serviceId: service.id,
    ownerId: service.ownerId,
    serviceType: service.type,
    suspended: service.suspended === "suspended",
    region: details.region,
    plan: details.plan,
    runtime,
    image,
    repository: service.repo ?? null,
    branch: service.branch ?? null,
    rootDirectory: service.rootDir ?? null,
    buildCommand,
    startCommand,
    preDeployCommand,
    healthPath,
    automaticDeployments: false,
    automaticDeployTrigger: "off",
    shutdownDelaySeconds: details.maxShutdownDelaySeconds,
    instanceCount: details.numInstances,
    environmentSha256,
  });
};
