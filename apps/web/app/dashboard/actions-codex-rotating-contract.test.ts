import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("dashboard rotating namespace activation contract", () => {
  it("detects rotating providers with the canonical persisted auth mode", () => {
    const source = readFileSync(
      new URL(
        "../../src/server/codex-rotating-workflow-activation.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("authMode: codexRotatingAuthMode");
    expect(source).not.toContain('authMode: "codex-oauth-rotating"');
  });

  it("uses the witness-bound namespace inspector without a latest-claim fallback", () => {
    const source = readFileSync(
      new URL(
        "../../src/server/codex-rotating-workflow-activation.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const activation = sliceBetween(
      source,
      "export async function activateConfirmedCodexNamespaceAfterWorkflowMerge",
      "function readGitHubRepositoryIdentity",
    );

    expect(activation).toContain("inspectCodexRotatingWorkflowNamespace");
    expect(activation).toContain('inspection.source === "active"');
    expect(activation).not.toContain("codexOAuthSetupPayloadClaim.findFirst");
    expect(activation).not.toContain("if (!claim) return");
  });

  it("uses configured B only for a candidate and keeps an active namespace on verified A", () => {
    const source = readFileSync(
      new URL("./actions.ts", import.meta.url),
      "utf8",
    );
    const helper = sliceBetween(
      source,
      "async function resolveCodexRotatingProvisioningActionRef",
      "function readGitHubRepositoryIdentity",
    );

    expect(helper).toContain(
      'input.inspection.source === "confirmed_setup_candidate"',
    );
    expect(helper).toContain(
      "return resolveReviewRouterCodexRotatingActionRef()",
    );
    expect(helper).toContain("assertTrustedCanonicalVersionedWorkflow");
    expect(helper).toContain(
      "isVersionedSecretNamespaceCodexWorkflowSchemaVersion",
    );
    expect(helper).toContain(
      "expectedWorkflowSchemaVersion: expectedSource.workflowSchemaVersion",
    );
    expect(helper).toContain("workflowSchemaVersion: true");
    expect(helper).toContain("expectedSource.workflowSchemaVersion === null");
    expect(helper).not.toContain(
      "expectedWorkflowSchemaVersion: metadata.workflowSchemaVersion",
    );
    expect(helper).toContain(
      "expectedSecretNamespace: input.inspection.namespace",
    );
    expect(helper).toContain("codexOAuthSecretNamespace.findUnique");
    expect(helper).toContain("ref: expectedSource.workflowSourceCommitSha");
    expect(helper).toContain("assertActiveVersionedSecretWorkflowAttestation");
    expect(helper).toContain("return metadata.actionRef");
    expect(
      helper.indexOf("assertActiveVersionedSecretWorkflowAttestation"),
    ).toBeLessThan(helper.indexOf("return metadata.actionRef"));
    expect(helper).not.toContain("resolveReviewRouterActionRef");
  });

  it("exhaustively routes production writer callsites through the application policy", () => {
    const dashboard = readFileSync(
      new URL("./actions.ts", import.meta.url),
      "utf8",
    );
    const activation = readFileSync(
      new URL(
        "../../src/server/codex-rotating-workflow-activation.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const cli = readFileSync(
      new URL(
        "../api/codex-rotating/cli/workflow-activate/route.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const policy = readFileSync(
      new URL(
        "../../src/server/codex-rotating-writer-schema-policy.ts",
        import.meta.url,
      ),
      "utf8",
    );

    const writerCallsites = [
      {
        name: "hosted-to-repository dashboard provisioning",
        source: dashboard,
        start: "async function provisionPendingRepositoryOwnedWorkflow",
        end: "function createHostedPoolDashboardMutationDependencies",
        markers: [
          "selectCodexRotatingWriterSchemaVersion",
          "codexRotatingWorkflowSchemaVersion: writerSchemaVersion",
        ],
      },
      {
        name: "dashboard setup readiness and provisioning",
        source: dashboard,
        start: "async function createSetupPullRequestMutation",
        end: "async function confirmSetupPullRequestMergedMutation",
        markers: [
          "selectCodexRotatingWriterSchemaVersion",
          "isWorkflowSetupAlreadyCurrent(",
          "provisionRepositoryReviewRouterWorkflow(",
        ],
      },
      {
        name: "dashboard merge readiness and activation",
        source: dashboard,
        start: "async function confirmSetupPullRequestMergedMutation",
        end: "async function confirmProviderSecretSetupMutation",
        markers: [
          "selectCodexRotatingWriterSchemaVersion",
          "writerSchemaPolicy",
          "activateConfirmedCodexNamespaceAfterWorkflowMerge",
        ],
      },
      {
        name: "dashboard provider activation",
        source: dashboard,
        start: "async function confirmProviderSecretSetupMutation",
        end: "async function createMemoryItemMutation",
        markers: [
          "writerSchemaPolicy",
          "activateConfirmedCodexNamespaceAfterWorkflowMerge",
        ],
      },
      {
        name: "CLI activation",
        source: cli,
        start: "export async function POST",
        end: "function readBearerToken",
        markers: [
          "writerSchemaPolicy: createCodexRotatingWriterSchemaPolicy()",
          "activateConfirmedCodexNamespaceAfterWorkflowMerge",
        ],
      },
    ] as const;

    for (const callsite of writerCallsites) {
      const callsiteSource = sliceBetween(
        callsite.source,
        callsite.start,
        callsite.end,
      );
      for (const marker of callsite.markers) {
        expect(callsiteSource, callsite.name).toContain(marker);
      }
    }

    expect(activation).toContain(
      "input.writerSchemaPolicy.selectWriterSchemaVersion",
    );
    expect(policy).toContain("existingWorkflowSchemaVersion");
    expect(policy).toContain("runtimeReleaseCommitSha");
    expect(policy).not.toContain("1fb0e2ee21fcb03550211eea83677872fab82b5b");
    for (const source of [dashboard, activation, cli]) {
      expect(source).not.toContain("VersionedSecretNamespaceV5");
    }
    expect(count(dashboard, "provisionRepositoryReviewRouterWorkflow(")).toBe(
      2,
    );
    expect(count(dashboard, "isWorkflowSetupAlreadyCurrent(")).toBe(2);
    expect(
      count(dashboard, "activateConfirmedCodexNamespaceAfterWorkflowMerge({"),
    ).toBe(2);
    expect(
      count(cli, "activateConfirmedCodexNamespaceAfterWorkflowMerge({"),
    ).toBe(1);
  });
});

function count(source: string, value: string): number {
  return source.split(value).length - 1;
}

function sliceBetween(source: string, startAnchor: string, endAnchor: string) {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
