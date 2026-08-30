import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

export const reviewedActivationCatalogCandidateRepositoryPath =
  "docs/release-evidence/activation-catalog-policy-v29-schema-v5-pr245-candidate.json";

export const reviewedActivationCatalogCandidatePath = resolve(
  repositoryRoot,
  reviewedActivationCatalogCandidateRepositoryPath,
);
