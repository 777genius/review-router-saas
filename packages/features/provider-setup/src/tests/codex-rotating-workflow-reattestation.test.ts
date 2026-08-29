import { describe, expect, it, vi } from "vitest";
import { reattestCodexRotatingWorkflow } from "../application/use-cases/reattest-codex-rotating-workflow";

describe("reattestCodexRotatingWorkflow", () => {
  it("invokes the application port with the exact transition", async () => {
    const replaceActiveWorkflowSource = vi
      .fn()
      .mockResolvedValue({ status: "active" as const });
    const input = {
      claimId: "claim_1",
      attemptId: "attempt_1",
      namespaceId: "runtime_namespace_2",
      namespaceEpoch: "2",
      secretName: "REVIEWROUTER_CODEX_AUTH_JSON_TEST_E2",
      repositoryId: "1228051727",
      expectedGenerationHash: "9".repeat(64),
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSourceCommitSha: "a".repeat(40),
      workflowSourceBlobSha: "b".repeat(40),
      workflowSourceSha256: "c".repeat(64),
      workflowSemanticSha256: "d".repeat(64),
      sourceTrust: "trusted_default_branch_revision",
      expectedCurrentWorkflowSchemaVersion: 4 as const,
      workflowSchemaVersion: 5 as const,
      expectedCurrentWorkflowSourceCommitSha: "e".repeat(40),
      expectedCurrentWorkflowSourceBlobSha: "f".repeat(40),
      expectedCurrentWorkflowSourceSha256: "1".repeat(64),
      expectedCurrentWorkflowSemanticSha256: "2".repeat(64),
    };

    await expect(
      reattestCodexRotatingWorkflow(input, {
        workflowReattestation: { replaceActiveWorkflowSource },
      }),
    ).resolves.toEqual({ status: "active" });
    expect(replaceActiveWorkflowSource).toHaveBeenCalledWith(input);
  });
});
