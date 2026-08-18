import { sourceWriterServiceIdsAreValid } from "./source-writer-service-ids";

export type SourceFreezeRecoveryFacts = Readonly<{
  activationBoundary: "before" | "uncertain" | "activated";
  sourceFreeze: Readonly<{
    status: "none" | "partial" | "complete" | "unknown";
    serviceIds: readonly string[];
    services: readonly Readonly<{
      serviceId: string;
      latestSuccessfulDeployId: string;
      observedAt: string;
    }>[];
  }>;
}>;

export type SourceFreezeRecoveryDecision =
  | Readonly<{ outcome: "recover"; serviceIds: readonly string[] }>
  | Readonly<{
      outcome: "no_op" | "forward_only" | "denied";
      serviceIds: readonly [];
    }>;

/** Pure policy over authority-owned facts. Provider adapters cannot weaken it. */
export function decideSourceFreezeRecovery(
  checkpoint: SourceFreezeRecoveryFacts,
): SourceFreezeRecoveryDecision {
  if (checkpoint.activationBoundary !== "before")
    return { outcome: "forward_only", serviceIds: [] };
  if (checkpoint.sourceFreeze.status === "none")
    return { outcome: "no_op", serviceIds: [] };
  const { serviceIds, services, status } = checkpoint.sourceFreeze;
  if (
    (status !== "partial" && status !== "complete") ||
    !sourceWriterServiceIdsAreValid(serviceIds) ||
    services.length !== serviceIds.length ||
    services.some(
      (service, index) =>
        service.serviceId !== serviceIds[index] ||
        !service.latestSuccessfulDeployId ||
        !Number.isFinite(Date.parse(service.observedAt)),
    )
  )
    return { outcome: "denied", serviceIds: [] };
  return { outcome: "recover", serviceIds: Object.freeze([...serviceIds]) };
}
