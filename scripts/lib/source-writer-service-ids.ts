import { sourceWriterServiceIdsAreValid } from "../../packages/features/release-rollout/src/domain/source-writer-service-ids";

export const parseSourceWriterServiceIds = (
  encoded: string,
): readonly string[] => {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("source_writer_service_ids_json_invalid");
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (serviceId): serviceId is unknown => typeof serviceId !== "string",
    )
  )
    throw new Error("source_writer_service_ids_invalid");
  const serviceIds = value as string[];
  if (new Set(serviceIds).size !== serviceIds.length)
    throw new Error("source_writer_service_ids_duplicate");
  if (!sourceWriterServiceIdsAreValid(serviceIds))
    throw new Error("source_writer_service_ids_invalid");
  if (
    serviceIds.some(
      (serviceId, index) => index > 0 && serviceIds[index - 1]! >= serviceId,
    )
  )
    throw new Error("source_writer_service_ids_not_sorted");
  if (JSON.stringify(serviceIds) !== encoded)
    throw new Error("source_writer_service_ids_not_canonical");
  return Object.freeze([...serviceIds]);
};
