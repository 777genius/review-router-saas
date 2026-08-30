// Shared build-time identity used by both the domain transition and the live
// PostgreSQL catalog projection. It must remain a single exact digest.
export const canonicalReleaseMigrationPostManifestIdentity =
  "sha256:999db187a11177b7e1a7a2440b428b43f8a852a86473746f2e4a60d858ebccce";
