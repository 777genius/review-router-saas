// Shared build-time identity used by both the domain transition and the live
// PostgreSQL catalog projection. It must remain a single exact digest.
export const canonicalReleaseMigrationPostManifestIdentity =
  "sha256:381abaecf082c48e20ac2b620d50fd72b12cc974d6cde894529961b269a644d4";
