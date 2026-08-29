// Shared build-time identity used by both the domain transition and the live
// PostgreSQL catalog projection. It must remain a single exact digest.
export const canonicalReleaseMigrationPostManifestIdentity =
  "sha256:56445769d2cb09dcd4df27975ea41034f9e1deb6d399c94672bce9b35bc08e29";
