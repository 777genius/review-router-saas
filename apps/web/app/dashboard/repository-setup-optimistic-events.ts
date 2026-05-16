export const providerSetupConfirmedEventName =
  "reviewrouter:provider-setup-confirmed";
export const setupPullRequestMergedEventName =
  "reviewrouter:setup-pull-request-merged";

export type ProviderSetupConfirmedEventDetail = {
  readonly repositoryId: string;
  readonly repositoryFullName: string;
};

export type SetupPullRequestMergedEventDetail = {
  readonly repositoryId: string;
};

export function providerSetupConfirmedEvent(
  detail: ProviderSetupConfirmedEventDetail,
): CustomEvent<ProviderSetupConfirmedEventDetail> {
  return new CustomEvent(providerSetupConfirmedEventName, { detail });
}

export function setupPullRequestMergedEvent(
  detail: SetupPullRequestMergedEventDetail,
): CustomEvent<SetupPullRequestMergedEventDetail> {
  return new CustomEvent(setupPullRequestMergedEventName, { detail });
}
