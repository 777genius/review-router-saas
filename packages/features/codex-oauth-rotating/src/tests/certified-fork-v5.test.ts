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
const namespace = allocateVersionedProviderSecretNamespace({
  scope: {
    repositoryId: "1163183284",
    providerInstanceId: "codex-rotating:1163183284",
  },
  epoch: 9n,
  randomBytes: () => Buffer.alloc(16, 9),
});

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
    activeSecretNamespace: namespace,
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
    const forkJob = rendered.slice(
      rendered.indexOf("  fork-sandbox-review:"),
      rendered.indexOf("  fork-backfill-review:"),
    );
    expect(forkJob).toContain(`auth-json: \${{ secrets.${namespace.name} }}`);
    expect(forkJob).toContain("    permissions:\n      id-token: write");
    expect(forkJob).not.toContain("contents: read");
    expect(forkJob).not.toContain("actions/checkout@");
    expect(forkJob).not.toContain("safe-workspace");
    expect(forkJob).not.toContain("REVIEW_ROUTER_PR_WORKSPACE");
    expect(forkJob.match(/^ {6}- name:/gm)).toHaveLength(1);
    expect(forkJob).toContain(`uses: 777genius/review-router@${actionSha}`);
    expect(forkJob.match(/\$\{\{ secrets\./g)).toHaveLength(1);
    expect(rendered).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(rendered).not.toContain("OPENROUTER_API_KEY");
    expect(readCodexRotatingWorkflowSourceMetadata(rendered)).toMatchObject({
      actionRef: `777genius/review-router@${actionSha}`,
      workflowSchemaVersion: 5,
    });
  });

  it("renders a dispatch-only exact-head fork backfill lane", () => {
    const rendered = workflow();
    expect(rendered).toContain("  workflow_dispatch:\n    inputs:");
    for (const input of [
      "source_repository",
      "source_repository_id",
      "pull_request_number",
      "review_head_sha",
      "base_sha",
    ]) {
      expect(rendered).toContain(`      ${input}:\n        description:`);
    }
    const backfillJob = rendered.slice(
      rendered.indexOf("  fork-backfill-review:"),
    );
    expect(backfillJob).toContain("github.event_name == 'workflow_dispatch'");
    expect(backfillJob).toContain(
      "source-repository: ${{ inputs.source_repository }}",
    );
    expect(backfillJob).toContain("base-repository: ${{ github.repository }}");
    expect(backfillJob).toContain(
      "base-repository-id: ${{ github.repository_id }}",
    );
    expect(backfillJob).not.toContain("inputs.base_repository");
    expect(backfillJob).not.toContain("inputs.base_repository_id");
    expect(backfillJob).not.toContain("github.event.pull_request");
    expect(backfillJob).toContain("    permissions:\n      id-token: write");
    expect(backfillJob).not.toContain("contents: read");
    expect(backfillJob).not.toContain("GITHUB_TOKEN");
    expect(backfillJob).not.toContain("run:");
    expect(backfillJob).not.toContain("env:");
    expect(backfillJob.match(/^ {6}- name:/gm)).toHaveLength(1);
    expect(backfillJob.match(/\$\{\{ secrets\./g)).toHaveLength(1);
  });

  it.each([
    ["optional input", "        required: true", "        required: false"],
    [
      "extra dispatch input",
      "      base_sha:\n",
      "      attacker_input:\n        required: true\n        type: string\n      base_sha:\n",
    ],
    [
      "repository dispatch",
      "  workflow_dispatch:\n",
      "  repository_dispatch:\n  workflow_dispatch:\n",
    ],
    [
      "duplicate dispatch",
      "  workflow_dispatch:\n",
      "  workflow_dispatch:\n  workflow_dispatch:\n",
    ],
    [
      "source from event payload",
      "source-repository: ${{ inputs.source_repository }}",
      "source-repository: ${{ github.event.inputs.source_repository }}",
    ],
    [
      "base from user input",
      "base-repository: ${{ github.repository }}",
      "base-repository: ${{ inputs.base_repository }}",
    ],
    [
      "backfill checkout",
      "      - name: ReviewRouter certified fork backfill review",
      "      - name: Checkout\n        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\n\n      - name: ReviewRouter certified fork backfill review",
    ],
    [
      "backfill secret exfiltration",
      "        with:\n          mode: fork_prompt_only_v2",
      `        env:\n          STOLEN_AUTH: \${{ secrets.${namespace.name} }}\n        with:\n          mode: fork_prompt_only_v2`,
    ],
  ])("rejects backfill tamper: %s", (_name, marker, replacement) => {
    const rendered = workflow();
    const backfillStart = rendered.indexOf("  fork-backfill-review:");
    const prefix = rendered.slice(0, backfillStart);
    const backfill = rendered.slice(backfillStart).replace(marker, replacement);
    const tampered = [
      "optional input",
      "extra dispatch input",
      "repository dispatch",
      "duplicate dispatch",
    ].includes(_name)
      ? rendered.replace(marker, replacement)
      : `${prefix}${backfill}`;
    expect(scanCodexRotatingAdvisoryWorkflow(tampered).valid).toBe(false);
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
      "untrusted script",
      "      - name: ReviewRouter certified fork review",
      "      - run: npm test\n\n      - name: ReviewRouter certified fork review",
    ],
    [
      "contents permission",
      "    permissions:\n      id-token: write\n    steps:",
      "    permissions:\n      contents: read\n      id-token: write\n    steps:",
    ],
    [
      "write permission",
      "    permissions:\n      id-token: write\n    steps:",
      "    permissions:\n      pull-requests: write\n      id-token: write\n    steps:",
    ],
    [
      "NODE_OPTIONS preload",
      "        with:\n          mode: fork_prompt_only_v2",
      "        env:\n          NODE_OPTIONS: --require /tmp/attacker.cjs\n        with:\n          mode: fork_prompt_only_v2",
    ],
    [
      "secret environment",
      "        with:\n          mode: fork_prompt_only_v2",
      `        env:\n          STOLEN_AUTH: \${{ secrets.${namespace.name} }}\n        with:\n          mode: fork_prompt_only_v2`,
    ],
    [
      "extra fork action input",
      "          auth-json: ${{ secrets.",
      "          attacker-input: true\n          auth-json: ${{ secrets.",
    ],
    [
      "arbitrary fork secret",
      `          auth-json: \${{ secrets.${namespace.name} }}`,
      "          auth-json: ${{ secrets.ATTACKER }}",
    ],
    [
      "dynamic fork secret",
      `          auth-json: \${{ secrets.${namespace.name} }}`,
      "          auth-json: ${{ secrets['ATTACKER'] }}",
    ],
    [
      "checkout action",
      "      - name: ReviewRouter certified fork review",
      "      - name: Checkout fork\n        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\n\n      - name: ReviewRouter certified fork review",
    ],
    [
      "other action",
      `        uses: 777genius/review-router@${actionSha}`,
      "        uses: attacker/action@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ],
    [
      "local action",
      `        uses: 777genius/review-router@${actionSha}`,
      "        uses: ./attacker",
    ],
    [
      "extra same-repository secret",
      "      CODEX_AUTH_JSON: ${{ secrets.",
      "      ATTACKER: ${{ secrets.ATTACKER }}\n      CODEX_AUTH_JSON: ${{ secrets.",
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
