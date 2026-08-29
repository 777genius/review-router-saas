import {
  allocateVersionedProviderSecretNamespace,
  createVersionedSecretWorkflowSourceAttestation,
  WorkflowSourceTrust,
} from "@reviewrouter/features-codex-oauth-rotating";
import { describe, expect, it, vi } from "vitest";
import { reattestCodexRotatingWorkflow } from "../application/use-cases/reattest-codex-rotating-workflow";

const namespace = allocateVersionedProviderSecretNamespace({
  scope: {
    repositoryId: "1228051727",
    providerInstanceId: "codex-rotating:1228051727",
  },
  epoch: 2n,
  randomBytes: () => new Uint8Array(16).fill(0x22),
});
const target = {
  claimId: "claim_1",
  attemptId: "attempt_1",
  expectedGenerationHash: "9".repeat(64),
  repositoryId: "1228051727",
  workflowPath: ".github/workflows/reviewrouter-codex.yml",
  namespace,
} as const;

const attestation = (schema: 4 | 5, marker: string, commitMarker = marker) =>
  createVersionedSecretWorkflowSourceAttestation({
    repositoryId: target.repositoryId,
    workflowPath: target.workflowPath,
    workflowSourceCommitSha: commitMarker.repeat(40),
    workflowSourceBlobSha: marker.repeat(40),
    workflowSourceSha256: marker.repeat(64),
    workflowSemanticSha256: marker.repeat(64),
    workflowSchemaVersion: schema,
    sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
    secretNamespace: namespace,
  });

describe("reattestCodexRotatingWorkflow", () => {
  it("owns the exact V4-to-V5 evidence policy and transactional transition", async () => {
    const current = attestation(4, "4");
    const replacement = attestation(5, "5");
    const replaceActiveWorkflowSource = vi
      .fn()
      .mockResolvedValue({ status: "active" as const });
    const readVerifiedWorkflowAt = vi.fn(async ({ expectedSchemaVersion }) =>
      expectedSchemaVersion === 5 ? replacement : current,
    );
    const readDefaultHead = vi
      .fn()
      .mockResolvedValue(replacement.workflowSourceCommitSha);

    await expect(
      reattestCodexRotatingWorkflow(target, {
        currentWorkflowAttestation: {
          readActiveWorkflowAttestation: vi.fn().mockResolvedValue(current),
        },
        defaultWorkflowSource: {
          readDefaultHead,
          readVerifiedWorkflowAt,
        },
        workflowReattestation: { replaceActiveWorkflowSource },
      }),
    ).resolves.toEqual({
      status: "reattested",
      workflowSourceCommitSha: replacement.workflowSourceCommitSha,
    });
    expect(readVerifiedWorkflowAt).toHaveBeenNthCalledWith(1, {
      commitSha: replacement.workflowSourceCommitSha,
      expectedSchemaVersion: 5,
    });
    expect(readVerifiedWorkflowAt).toHaveBeenNthCalledWith(2, {
      commitSha: current.workflowSourceCommitSha,
      expectedSchemaVersion: 4,
    });
    expect(readDefaultHead).toHaveBeenCalledTimes(2);
    expect(replaceActiveWorkflowSource).toHaveBeenCalledWith({
      target,
      expectedCurrent: current,
      replacement,
    });
  });

  it("preserves same-byte V5 admission across an unrelated default-head commit", async () => {
    const current = attestation(5, "5", "4");
    const replacement = attestation(5, "5", "6");
    const replaceActiveWorkflowSource = vi.fn();
    const readDefaultHead = vi
      .fn()
      .mockResolvedValue(replacement.workflowSourceCommitSha);

    await expect(
      reattestCodexRotatingWorkflow(target, {
        currentWorkflowAttestation: {
          readActiveWorkflowAttestation: vi.fn().mockResolvedValue(current),
        },
        defaultWorkflowSource: {
          readDefaultHead,
          readVerifiedWorkflowAt: vi.fn().mockResolvedValue(replacement),
        },
        workflowReattestation: { replaceActiveWorkflowSource },
      }),
    ).resolves.toEqual({
      status: "already_active",
      workflowSourceCommitSha: replacement.workflowSourceCommitSha,
    });
    expect(replaceActiveWorkflowSource).not.toHaveBeenCalled();
  });

  it("rejects a previous blob that does not reproduce durable V4 evidence", async () => {
    const current = attestation(4, "4");
    const replacement = attestation(5, "5");
    const changedPrevious = attestation(4, "3", "4");
    const replaceActiveWorkflowSource = vi.fn();

    await expect(
      reattestCodexRotatingWorkflow(target, {
        currentWorkflowAttestation: {
          readActiveWorkflowAttestation: vi.fn().mockResolvedValue(current),
        },
        defaultWorkflowSource: {
          readDefaultHead: vi
            .fn()
            .mockResolvedValue(replacement.workflowSourceCommitSha),
          readVerifiedWorkflowAt: vi
            .fn()
            .mockResolvedValueOnce(replacement)
            .mockResolvedValueOnce(changedPrevious),
        },
        workflowReattestation: { replaceActiveWorkflowSource },
      }),
    ).rejects.toThrow("codex_rotating_workflow_previous_attestation_mismatch");
    expect(replaceActiveWorkflowSource).not.toHaveBeenCalled();
  });

  it("rejects a default-head race before persistence", async () => {
    const current = attestation(4, "4");
    const replacement = attestation(5, "5");
    const replaceActiveWorkflowSource = vi.fn();

    await expect(
      reattestCodexRotatingWorkflow(target, {
        currentWorkflowAttestation: {
          readActiveWorkflowAttestation: vi.fn().mockResolvedValue(current),
        },
        defaultWorkflowSource: {
          readDefaultHead: vi
            .fn()
            .mockResolvedValueOnce(replacement.workflowSourceCommitSha)
            .mockResolvedValueOnce("6".repeat(40)),
          readVerifiedWorkflowAt: vi
            .fn()
            .mockResolvedValueOnce(replacement)
            .mockResolvedValueOnce(current),
        },
        workflowReattestation: { replaceActiveWorkflowSource },
      }),
    ).rejects.toThrow("codex_rotating_workflow_default_head_changed");
    expect(replaceActiveWorkflowSource).not.toHaveBeenCalled();
  });
});
