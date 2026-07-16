import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanCodexRotatingAdvisoryWorkflow } from "../domain/codex-oauth-rotating.js";

const workflowPath = fileURLToPath(
  new URL(
    "../../../../../.github/workflows/reviewrouter-codex.yml",
    import.meta.url,
  ),
);

describe("checked-in Codex OAuth workflow", () => {
  it("matches the hosted workflow security contract", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(scanCodexRotatingAdvisoryWorkflow(workflow)).toEqual({
      valid: true,
      errors: [],
    });
  });
});
