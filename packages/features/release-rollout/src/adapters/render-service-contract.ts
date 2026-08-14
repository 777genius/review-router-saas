import type { RenderService } from "./render-api";

type SharedContract = Readonly<{
  serviceId: string;
  autoDeploy: "no";
  autoDeployTrigger: "off";
  preDeployCommand: string;
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
    region: string;
    plan: string;
    maxShutdownDelaySeconds: number;
    numInstances: number;
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
      !equalsCanonicalValue(preDeployCommand, this.value.preDeployCommand)
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
      !equalsCanonicalValue(healthCheckPath, this.value.healthCheckPath) ||
      details.region !== this.value.region ||
      details.plan !== this.value.plan ||
      details.maxShutdownDelaySeconds !== this.value.maxShutdownDelaySeconds
    )
      return false;

    return details.numInstances === this.value.numInstances;
  }
}
