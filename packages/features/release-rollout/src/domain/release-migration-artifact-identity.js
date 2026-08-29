// Shared build-time identity used by both the domain transition and the live
// PostgreSQL catalog projection. It must remain a single exact digest.
export const canonicalReleaseMigrationPostManifestIdentity =
  "sha256:1e7ddd01bd9445480c8a68a31b8dcab2465a0fb7a5273a3104cfa26cacf0f8b9";
