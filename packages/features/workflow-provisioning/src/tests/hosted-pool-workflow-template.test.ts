import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertActiveHostedPoolWorkflowAttestation,
  canonicalHostedPoolReusableWorkflowIdentity,
  createHostedPoolWorkflowSourceAttestation,
  hostedPoolSessionMode,
  hostedPoolWorkflowSchemaVersion,
  hostedPoolWorkflowSemanticSha256,
  renderCanonicalHostedPoolWorkflowV2,
  scanCanonicalHostedPoolWorkflowV2,
} from "../domain/hosted-pool-workflow-template";
import {
  hostedPoolWorkflowV2Golden,
  hostedPoolWorkflowV2GoldenOptions,
  hostedPoolWorkflowV2GoldenSha256,
} from "./fixtures/hosted-pool-workflow-v2.golden";

const options = hostedPoolWorkflowV2GoldenOptions;

describe("hosted pool workflow schema v2", () => {
  it("derives the exact T0 reusable workflow identity from the immutable Action ref", () => {
    expect(
      canonicalHostedPoolReusableWorkflowIdentity(options.actionRef),
    ).toEqual({
      ref: "777genius/review-router/.github/workflows/reviewrouter-t0-reusable.yml@0123456789abcdef0123456789abcdef01234567",
      sha: "0123456789abcdef0123456789abcdef01234567",
    });
  });

  it("renders the exact trusted OIDC workflow without credential ingress", () => {
    const workflow = renderCanonicalHostedPoolWorkflowV2(options);

    expect(workflow).toBe(hostedPoolWorkflowV2Golden);
    expect(createHash("sha256").update(workflow).digest("hex")).toBe(
      hostedPoolWorkflowV2GoldenSha256,
    );
    expect(workflow).toContain("  pull_request:");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain("      id-token: write");
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(workflow).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-t0-reusable.yml@0123456789abcdef0123456789abcdef01234567",
    );
    expect(workflow).toContain(`codex_session_mode: ${hostedPoolSessionMode}`);
    expect(workflow).toContain('session_binding_id: "hosted-binding-1"');
    expect(workflow).toContain("session_binding_version: 7");
    expect(workflow).toContain(
      `workflow_schema_version: ${hostedPoolWorkflowSchemaVersion}`,
    );
    expect(workflow).not.toMatch(
      /CODEX_AUTH_JSON|auth-json|auth\.json|secrets\.|secrets:\s*inherit/iu,
    );
    expect(workflow).not.toMatch(/^\s*secrets\s*:/imu);
    expect(workflow).not.toMatch(/^\s*schedule\s*:/imu);
    expect(workflow).not.toContain("codex-refresh");
    expect(workflow).not.toContain("concurrency:");
    expect(scanCanonicalHostedPoolWorkflowV2(workflow)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it.each([
    "      CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    "      auth-json: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
    "    secrets: inherit",
    "      unsafe: ${{ toJSON(secrets) }}",
    "  schedule:\n    - cron: '17 */6 * * *'",
  ])("fails closed when credential or refresh ingress is added: %s", (line) => {
    const workflow = `${renderCanonicalHostedPoolWorkflowV2(options)}${line}\n`;
    expect(scanCanonicalHostedPoolWorkflowV2(workflow)).toMatchObject({
      valid: false,
    });
  });

  it("rejects the prohibited pull_request_target event policy", () => {
    const workflow = renderCanonicalHostedPoolWorkflowV2(options).replaceAll(
      "pull_request",
      "pull_request_target",
    );
    expect(scanCanonicalHostedPoolWorkflowV2(workflow)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        "hosted_workflow_trusted_ingress_required",
      ]),
    });
  });

  it("rejects stale binding attestations even when workflow bytes are exact", () => {
    const workflow = renderCanonicalHostedPoolWorkflowV2(options);
    const attestation = createHostedPoolWorkflowSourceAttestation({
      repositoryId: "123456",
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSourceCommitSha: "a".repeat(40),
      workflowSourceBlobSha: "b".repeat(40),
      workflowSourceSha256: createHash("sha256").update(workflow).digest("hex"),
      workflowSemanticSha256: hostedPoolWorkflowSemanticSha256(workflow),
      sourceTrust: "trusted_default_branch_revision",
      bindingId: options.bindingId,
      bindingRevision: options.bindingRevision,
    });

    expect(() =>
      assertActiveHostedPoolWorkflowAttestation({
        attestation,
        repositoryId: "123456",
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSourceCommitSha: "a".repeat(40),
        expectedBindingId: options.bindingId,
        expectedBindingRevision: options.bindingRevision + 1,
        expectedWorkflow: workflow,
        expectedWorkflowSourceBlobSha: "b".repeat(40),
      }),
    ).toThrow("hosted_workflow_attestation_binding_mismatch");
  });

  it("accepts exact trusted source evidence for the current binding revision", () => {
    const workflow = renderCanonicalHostedPoolWorkflowV2(options);
    const attestation = createHostedPoolWorkflowSourceAttestation({
      repositoryId: "123456",
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSourceCommitSha: "a".repeat(40),
      workflowSourceBlobSha: "b".repeat(40),
      workflowSourceSha256: createHash("sha256").update(workflow).digest("hex"),
      workflowSemanticSha256: hostedPoolWorkflowSemanticSha256(workflow),
      sourceTrust: "trusted_default_branch_revision",
      bindingId: options.bindingId,
      bindingRevision: options.bindingRevision,
    });

    expect(() =>
      assertActiveHostedPoolWorkflowAttestation({
        attestation,
        repositoryId: "123456",
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSourceCommitSha: "a".repeat(40),
        expectedBindingId: options.bindingId,
        expectedBindingRevision: options.bindingRevision,
        expectedWorkflow: workflow,
        expectedWorkflowSourceBlobSha: "b".repeat(40),
      }),
    ).not.toThrow();
  });
});
