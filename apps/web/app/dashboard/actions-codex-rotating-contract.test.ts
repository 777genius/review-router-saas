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
});

function sliceBetween(source: string, startAnchor: string, endAnchor: string) {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
