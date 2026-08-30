import { describe, expect, it } from "vitest";
import {
  allocateVersionedProviderSecretNamespace,
  assertActiveVersionedSecretWorkflowAttestation,
  assertTrustedCanonicalVersionedWorkflow,
  createVersionedSecretWorkflowSourceAttestation,
  CodexRotatingT0WorkflowSchemaVersion,
  readCanonicalCodexRotatingT0WorkflowSourceMetadata,
  renderCanonicalCodexRotatingT0WorkflowV4,
  renderCanonicalCodexRotatingT0WorkflowV5,
  WorkflowSourceTrust,
} from "../index.js";

const namespace = allocateVersionedProviderSecretNamespace({
  scope: {
    repositoryId: "123456",
    providerInstanceId: "codex-rotating:123456",
  },
  epoch: 1n,
  randomBytes: () => Buffer.alloc(16, 1),
});
const evidence = {
  repositoryId: "123456",
  workflowPath: ".github/workflows/reviewrouter-codex.yml",
  workflowSourceCommitSha: "a".repeat(40),
  workflowSourceBlobSha: "b".repeat(40),
  workflowSourceSha256: "c".repeat(64),
  workflowSemanticSha256: "d".repeat(64),
  sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
  secretNamespace: namespace,
} as const;

describe("exact active workflow attestation", () => {
  it("binds blob, content, semantic, repository, trust, revision and namespace", () => {
    const assert = (
      attestation: Parameters<
        typeof createVersionedSecretWorkflowSourceAttestation
      >[0] = evidence,
    ) =>
      assertActiveVersionedSecretWorkflowAttestation({
        attestation:
          createVersionedSecretWorkflowSourceAttestation(attestation),
        repositoryId: evidence.repositoryId,
        workflowPath: evidence.workflowPath,
        workflowSourceCommitSha: evidence.workflowSourceCommitSha,
        activeSecretNamespace: namespace,
        expectedWorkflowSource: evidence,
      });
    expect(() => assert()).not.toThrow();
    expect(() =>
      assert({ ...evidence, workflowSourceBlobSha: "e".repeat(40) }),
    ).toThrow("workflow_source_attestation_blob_mismatch");
    expect(() =>
      assert({ ...evidence, workflowSourceSha256: "e".repeat(64) }),
    ).toThrow("workflow_source_attestation_content_digest_mismatch");
    expect(() =>
      assert({ ...evidence, workflowSemanticSha256: "e".repeat(64) }),
    ).toThrow("workflow_source_attestation_semantic_digest_mismatch");
    expect(() => assert({ ...evidence, repositoryId: "654321" })).toThrow(
      "workflow_source_attestation_repository_mismatch",
    );
    expect(() =>
      assert({
        ...evidence,
        sourceTrust: WorkflowSourceTrust.MutableOrUntrusted,
      }),
    ).toThrow("workflow_source_attestation_untrusted");
  });

  it("accepts an exact unchanged workflow at a newer current default-branch revision", () => {
    expect(() =>
      assertActiveVersionedSecretWorkflowAttestation({
        attestation: createVersionedSecretWorkflowSourceAttestation({
          ...evidence,
          workflowSourceCommitSha: "e".repeat(40),
        }),
        repositoryId: evidence.repositoryId,
        workflowPath: evidence.workflowPath,
        workflowSourceCommitSha: "e".repeat(40),
        activeSecretNamespace: namespace,
        expectedWorkflowSource: evidence,
      }),
    ).not.toThrow();
  });

  it("accepts an exact canonical branch mirror anchored to the active default workflow", () => {
    expect(() =>
      assertActiveVersionedSecretWorkflowAttestation({
        attestation: createVersionedSecretWorkflowSourceAttestation({
          ...evidence,
          workflowSourceCommitSha: "e".repeat(40),
          sourceTrust: WorkflowSourceTrust.TrustedCanonicalBranchMirrorRevision,
        }),
        repositoryId: evidence.repositoryId,
        workflowPath: evidence.workflowPath,
        workflowSourceCommitSha: "e".repeat(40),
        activeSecretNamespace: namespace,
        expectedWorkflowSource: evidence,
      }),
    ).not.toThrow();

    expect(() =>
      assertActiveVersionedSecretWorkflowAttestation({
        attestation: createVersionedSecretWorkflowSourceAttestation({
          ...evidence,
          workflowSourceCommitSha: "e".repeat(40),
          workflowSourceSha256: "f".repeat(64),
          sourceTrust: WorkflowSourceTrust.TrustedCanonicalBranchMirrorRevision,
        }),
        repositoryId: evidence.repositoryId,
        workflowPath: evidence.workflowPath,
        workflowSourceCommitSha: "e".repeat(40),
        activeSecretNamespace: namespace,
        expectedWorkflowSource: evidence,
      }),
    ).toThrow("workflow_source_attestation_content_digest_mismatch");
  });

  it("trusts only configured repository, full-SHA action, API and canonical V4 namespace", () => {
    const actionRef =
      "777genius/review-router@0123456789abcdef0123456789abcdef01234567";
    const apiUrl = "https://api.reviewrouter.site";
    const workflow = renderCanonicalCodexRotatingT0WorkflowV4({
      actionRef,
      apiUrl,
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      activeSecretNamespace: namespace,
    });
    expect(workflow).toContain("  pull_request_target:");
    expect(workflow).not.toContain("  pull_request:");
    const metadata =
      readCanonicalCodexRotatingT0WorkflowSourceMetadata(workflow);
    const trusted = {
      metadata,
      observedRepositoryId: "123456",
      observedRepositoryFullName: "777genius/example",
      expectedRepositoryId: "123456",
      expectedRepositoryFullName: "777genius/example",
      trustedActionRefs: [actionRef],
      expectedApiUrl: apiUrl,
      expectedProviderInstanceId: "codex-rotating:123456",
      expectedSecretNamespace: namespace,
    } as const;
    expect(() =>
      assertTrustedCanonicalVersionedWorkflow(trusted),
    ).not.toThrow();
    expect(() =>
      assertTrustedCanonicalVersionedWorkflow({
        ...trusted,
        trustedActionRefs: [actionRef.toUpperCase()],
      }),
    ).not.toThrow();
    expect(() =>
      assertTrustedCanonicalVersionedWorkflow({
        ...trusted,
        trustedActionRefs: [
          "attacker/runtime@0123456789abcdef0123456789abcdef01234567",
        ],
      }),
    ).toThrow("codex_rotating_workflow_action_ref_not_trusted");
    expect(() =>
      assertTrustedCanonicalVersionedWorkflow({
        ...trusted,
        expectedApiUrl: "https://attacker.invalid",
      }),
    ).toThrow("codex_rotating_workflow_api_url_not_trusted");
    expect(() =>
      assertTrustedCanonicalVersionedWorkflow({
        ...trusted,
        observedRepositoryId: "999999",
      }),
    ).toThrow("codex_rotating_workflow_repository_identity_mismatch");
  });

  it("parses and trusts canonical V5 only when the expected schema matches", () => {
    const actionRef =
      "777genius/review-router@0123456789abcdef0123456789abcdef01234567";
    const apiUrl = "https://api.reviewrouter.site";
    const workflow = renderCanonicalCodexRotatingT0WorkflowV5({
      actionRef,
      apiUrl,
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      activeSecretNamespace: namespace,
    });
    const metadata =
      readCanonicalCodexRotatingT0WorkflowSourceMetadata(workflow);
    const trusted = {
      metadata,
      observedRepositoryId: "123456",
      observedRepositoryFullName: "777genius/example",
      expectedRepositoryId: "123456",
      expectedRepositoryFullName: "777genius/example",
      trustedActionRefs: [actionRef],
      expectedApiUrl: apiUrl,
      expectedProviderInstanceId: "codex-rotating:123456",
      expectedSecretNamespace: namespace,
      expectedWorkflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.CertifiedForkReviewV5,
    } as const;

    expect(metadata.workflowSchemaVersion).toBe(5);
    expect(() =>
      assertTrustedCanonicalVersionedWorkflow(trusted),
    ).not.toThrow();
    expect(() =>
      assertTrustedCanonicalVersionedWorkflow({
        ...trusted,
        expectedWorkflowSchemaVersion:
          CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
      }),
    ).toThrow("codex_rotating_workflow_schema_mismatch");
    expect(() =>
      readCanonicalCodexRotatingT0WorkflowSourceMetadata(
        workflow.replace(
          "        with:\n          mode: fork_prompt_only_v2",
          "        env:\n          NODE_OPTIONS: --require /tmp/attacker.cjs\n        with:\n          mode: fork_prompt_only_v2",
        ),
      ),
    ).toThrow("codex_rotating_t0_workflow_source_not_canonical");
    expect(() =>
      readCanonicalCodexRotatingT0WorkflowSourceMetadata(
        workflow.replace(
          `auth-json: \${{ secrets.${namespace.name} }}`,
          "auth-json: ${{ secrets.ATTACKER }}",
        ),
      ),
    ).toThrow("codex_rotating_t0_workflow_source_not_canonical");
  });
});
