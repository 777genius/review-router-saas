// Shared build-time identity used by both the domain transition and the live
// PostgreSQL catalog projection. It must remain a single exact digest.
export const canonicalReleaseMigrationPostManifestIdentity =
  "sha256:6c62ac869a47211043f8fffdd7af105cb6bd677b65462033195d41e7d7aafa2e";
