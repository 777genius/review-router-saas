const renderServiceId = /^srv-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const sourceWriterServiceIdsAreValid = (
  serviceIds: readonly string[],
): boolean =>
  serviceIds.length > 0 &&
  serviceIds.length <= 100 &&
  new Set(serviceIds).size === serviceIds.length &&
  serviceIds.every((serviceId) => renderServiceId.test(serviceId));
