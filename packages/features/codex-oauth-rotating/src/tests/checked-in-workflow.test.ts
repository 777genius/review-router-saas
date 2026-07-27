import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanCodexRotatingAdvisoryWorkflow } from "../domain/codex-oauth-rotating.js";
import { readCanonicalCodexRotatingT0WorkflowSourceMetadata } from "../domain/workflow-source-attestation.js";

const workflowPath = fileURLToPath(
  new URL(
    "../../../../../.github/workflows/reviewrouter-codex.yml",
    import.meta.url,
  ),
);

describe("checked-in Codex OAuth workflow", () => {
  it("matches the hosted v2 T0 workflow security contract", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(scanCodexRotatingAdvisoryWorkflow(workflow)).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      readCanonicalCodexRotatingT0WorkflowSourceMetadata(workflow),
    ).toEqual({
      actionRef:
        "777genius/review-router@a9df633cb0890263d27dc5e132bfc3f45fc347f6",
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:1228690265",
      workflowSchemaVersion: 1,
    });
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("pull_request_target:");
  });
});
