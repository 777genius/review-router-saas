// Shared build-time identity used by both the domain transition and the live
// PostgreSQL catalog projection. It must remain a single exact digest.
export const canonicalReleaseMigrationPostManifestIdentity =
  "sha256:29111f602134ef203c987d7f95b977b7977e9af971786378f034d83e75ec2fed";
