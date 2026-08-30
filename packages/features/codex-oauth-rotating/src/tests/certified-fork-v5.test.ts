import { describe, expect, it } from "vitest";
import {
  CodexRotatingReviewActionV2Mode,
  CodexRotatingT0WorkflowSchemaVersion,
  renderCodexRotatingAdvisoryWorkflow,
  readCodexRotatingWorkflowSourceMetadata,
  scanCodexRotatingAdvisoryWorkflow,
} from "../domain/codex-oauth-rotating";
import { allocateVersionedProviderSecretNamespace } from "../domain/provider-secret-namespace";

const actionSha = "a".repeat(40);

function workflow(): string {
  return renderCodexRotatingAdvisoryWorkflow({
    actionRef: `777genius/review-router@${actionSha}`,
    apiUrl: "https://api.reviewrouter.site",
    providerInstanceId: "codex-rotating:1163183284",
    workflowSchemaVersion:
      CodexRotatingT0WorkflowSchemaVersion.CertifiedForkReviewV5,
    reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    forkAgenticSandboxEnabled: true,
    refreshScheduleCron: null,
    activeSecretNamespace: allocateVersionedProviderSecretNamespace({
      scope: {
        repositoryId: "1163183284",
        providerInstanceId: "codex-rotating:1163183284",
      },
      epoch: 9n,
      randomBytes: () => Buffer.alloc(16, 9),
    }),
  });
}

describe("certified fork review workflow V5", () => {
  it("renders mutually exclusive same-repository and public-fork lanes", () => {
    const rendered = workflow();
    expect(scanCodexRotatingAdvisoryWorkflow(rendered)).toEqual({
      valid: true,
      errors: [],
    });
    expect(rendered).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(rendered).toContain(
      "github.event.pull_request.head.repo.full_name != github.repository",
    );
    expect(rendered).toContain(
      "github.event.pull_request.head.repo.private == false",
    );
    expect(rendered).toContain("trust-domain: fork");
    expect(rendered).toContain("mode: fork_prompt_only_v2");
    const forkJob = rendered.slice(rendered.indexOf("  fork-sandbox-review:"));
    expect(forkJob).not.toContain("auth-json:");
    expect(rendered).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(rendered).not.toContain("OPENROUTER_API_KEY");
    expect(readCodexRotatingWorkflowSourceMetadata(rendered)).toMatchObject({
      actionRef: `777genius/review-router@${actionSha}`,
      workflowSchemaVersion: 5,
    });
  });

  it.each([
    [
      "source repository spoof",
      "source-repository: ${{ github.event.pull_request.head.repo.full_name }}",
      "source-repository: attacker/spoof",
    ],
    [
      "source id spoof",
      "source-repository-id: ${{ format('{0}', github.event.pull_request.head.repo.id) }}",
      'source-repository-id: "1"',
    ],
    [
      "stale head",
      "review-head-sha: ${{ github.event.pull_request.head.sha }}",
      "review-head-sha: ${{ github.sha }}",
    ],
    [
      "mutable checkout",
      "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
      "actions/checkout@v6",
    ],
    [
      "credential persistence",
      "persist-credentials: false",
      "persist-credentials: true",
    ],
    ["checkout token", 'token: ""', "token: ${{ github.token }}"],
    [
      "untrusted script",
      "      - name: ReviewRouter certified fork review",
      "      - run: npm test\n\n      - name: ReviewRouter certified fork review",
    ],
    [
      "write token",
      "      id-token: write\n    steps:",
      "      id-token: write\n      pull-requests: write\n    steps:",
    ],
  ])("rejects %s", (_name, marker, replacement) => {
    const tampered = workflow().replace(marker, replacement);
    expect(scanCodexRotatingAdvisoryWorkflow(tampered).valid).toBe(false);
  });

  it("keeps V4 output independent of the V5 certification switch", () => {
    expect(() =>
      renderCodexRotatingAdvisoryWorkflow({
        actionRef: `777genius/review-router@${actionSha}`,
        apiUrl: "https://api.reviewrouter.site",
        providerInstanceId: "codex-rotating:1163183284",
        workflowSchemaVersion:
          CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
        reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
        forkAgenticSandboxEnabled: true,
        refreshScheduleCron: null,
        activeSecretNamespace: allocateVersionedProviderSecretNamespace({
          scope: {
            repositoryId: "1163183284",
            providerInstanceId: "codex-rotating:1163183284",
          },
          epoch: 9n,
          randomBytes: () => Buffer.alloc(16, 9),
        }),
      }),
    ).toThrow("codex_rotating_t0_fork_sandbox_not_supported");
  });
});
