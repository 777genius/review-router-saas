// Shared build-time identity used by both the domain transition and the live
// PostgreSQL catalog projection. It must remain a single exact digest.
export const canonicalReleaseMigrationPostManifestIdentity =
  "sha256:5faad7059a2f57055086dd1571e87706c261a486e8952334401f1d91cc41c97b";
