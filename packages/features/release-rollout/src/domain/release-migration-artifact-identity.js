// Shared build-time identity used by both the domain transition and the live
// PostgreSQL catalog projection. It must remain a single exact digest.
export const canonicalReleaseMigrationPostManifestIdentity =
  "sha256:7e53c8fe3c84c3979b6e8c6b1b8f5ded6734f2f053f0a17ae03a468a5939c063";
