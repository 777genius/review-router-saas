import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import {
  reviewedActivationCatalogCandidatePath,
  reviewedActivationCatalogCandidateRepositoryPath,
} from "./reviewed-activation-catalog-candidate.mjs";

describe("repository-owned reviewed activation catalog candidate", () => {
  it("resolves and pins the exact schema-v5 v29 PR245 raw evidence bytes", async () => {
    expect(reviewedActivationCatalogCandidateRepositoryPath).toBe(
      "docs/release-evidence/activation-catalog-policy-v29-schema-v5-pr245-candidate.json",
    );
    expect(isAbsolute(reviewedActivationCatalogCandidatePath)).toBe(true);

    const candidate = await readFile(reviewedActivationCatalogCandidatePath);
    expect(candidate.byteLength).toBe(2_651_682);
    expect(createHash("sha256").update(candidate).digest("hex")).toBe(
      "b138eb3ece6553d505debff1dc978a9b6fd8ea854cf70c037c05e364b3d0aa28",
    );
  });
});
