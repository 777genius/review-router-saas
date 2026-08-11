import { describe, expect, it } from "vitest";
import { assertDisposableRepositoryProvenance } from "../src/codex-rotating-live-e2e-provenance";

describe("Codex rotating live E2E repository provenance guard", () => {
  it("refuses an arbitrary pre-existing repository even when its name looks disposable", () => {
    expect(() =>
      assertDisposableRepositoryProvenance({
        repositoryId: "424242",
        repositoryFullName: "owner/rr-codex-e2e",
      }),
    ).toThrow(
      "codex_rotating_e2e_existing_repository_provenance_required:owner/rr-codex-e2e",
    );
  });

  it("requires the exact immutable GitHub repository id for intentional reuse", () => {
    expect(() =>
      assertDisposableRepositoryProvenance({
        repositoryId: "424242",
        repositoryFullName: "owner/rr-codex-e2e",
        expectedExistingRepositoryId: "434343",
      }),
    ).toThrow(
      "codex_rotating_e2e_existing_repository_id_mismatch:owner/rr-codex-e2e",
    );

    expect(() =>
      assertDisposableRepositoryProvenance({
        repositoryId: "424242",
        repositoryFullName: "owner/rr-codex-e2e",
        expectedExistingRepositoryId: "424242",
      }),
    ).not.toThrow();
  });

  it("rejects a GraphQL node id instead of comparing it to the REST numeric id", () => {
    expect(() =>
      assertDisposableRepositoryProvenance({
        repositoryId: "R_kgDOExample",
        repositoryFullName: "owner/rr-codex-e2e",
        expectedExistingRepositoryId: "424242",
      }),
    ).toThrow(
      "codex_rotating_e2e_repository_numeric_id_required:owner/rr-codex-e2e",
    );
  });

  it("rejects a deleted and recreated repository at the same name", () => {
    expect(() =>
      assertDisposableRepositoryProvenance({
        repositoryId: "434343",
        repositoryFullName: "owner/rr-codex-e2e",
        expectedExistingRepositoryId: "424242",
      }),
    ).toThrow(
      "codex_rotating_e2e_existing_repository_id_mismatch:owner/rr-codex-e2e",
    );
  });
});
