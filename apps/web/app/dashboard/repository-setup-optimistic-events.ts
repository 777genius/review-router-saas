export const providerSetupConfirmedEventName =
  "reviewrouter:provider-setup-confirmed";

export type ProviderSetupConfirmedEventDetail = {
  readonly repositoryId: string;
  readonly repositoryFullName: string;
};

export function providerSetupConfirmedEvent(
  detail: ProviderSetupConfirmedEventDetail,
): CustomEvent<ProviderSetupConfirmedEventDetail> {
  return new CustomEvent(providerSetupConfirmedEventName, { detail });
}
