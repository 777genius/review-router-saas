// Shared build-time identity used by both the domain transition and the live
// PostgreSQL catalog projection. It must remain a single exact digest.
export const canonicalReleaseMigrationPostManifestIdentity =
  "sha256:51fa79713bf7aff2a76f272c1a5e08a7a552ead6578dfe9ff99e09dd0a9302c7";
