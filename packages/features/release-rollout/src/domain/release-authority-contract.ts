/**
 * The installed release-authority schema version required by production
 * readiness and trusted rollout evidence.
 *
 * Keep this in the provider-neutral domain so readiness adapters and evidence
 * verification share one contract without either depending on the other.
 */
export const releaseAuthoritySchemaVersion = 16 as const;

export const releaseAuthorityBootstrapLifecycleStates = [
  "fresh",
  "retryable",
  "cleanup-pending",
  "terminal",
  "drifted",
] as const;

export type ReleaseAuthorityBootstrapLifecycle =
  (typeof releaseAuthorityBootstrapLifecycleStates)[number];

export type ProviderTrustRootPin = Readonly<{
  contractVersion: 1;
  systemIdentifier: string;
  rootOid: number;
  rootName: string;
  providerOid: number;
  providerName: "reviewrouter_bootstrap_administrator";
}>;

/**
 * The provider root is an attested external trust root, not a role whose
 * attributes or assumability ReviewRouter can constrain. Identity is the
 * complete cluster/OID/name tuple and P must be distinct from R.
 */
export const providerTrustRootPinIsOpaqueAndExact = (
  pin: ProviderTrustRootPin,
): boolean =>
  pin.contractVersion === 1 &&
  /^[1-9][0-9]*$/u.test(pin.systemIdentifier) &&
  Number.isSafeInteger(pin.rootOid) &&
  pin.rootOid > 0 &&
  Number.isSafeInteger(pin.providerOid) &&
  pin.providerOid > 0 &&
  pin.rootOid !== pin.providerOid &&
  pin.rootName.length > 0 &&
  pin.rootName !== pin.providerName;
