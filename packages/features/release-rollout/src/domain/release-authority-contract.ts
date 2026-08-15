/**
 * The installed release-authority schema version required by production
 * readiness and trusted rollout evidence.
 *
 * Keep this in the provider-neutral domain so readiness adapters and evidence
 * verification share one contract without either depending on the other.
 */
export const releaseAuthoritySchemaVersion = 13 as const;
