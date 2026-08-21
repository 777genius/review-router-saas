import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  ".github/workflows/codex-rotating-release-migration.yml",
  "utf8",
);

describe("Codex rotating release migration workflow", () => {
  it("keeps recovery and Action release identities separate", () => {
    expect(workflow).toContain("release_commit_sha:");
    expect(workflow).toContain("action_commit_sha:");
    expect(workflow).toContain(
      "ACTION_COMMIT_SHA: ${{ inputs.action_commit_sha }}",
    );
    expect(workflow).not.toContain(
      "ACTION_COMMIT_SHA: ${{ inputs.release_commit_sha }}",
    );
  });

  it("redeploys every runtime service and waits for live status", () => {
    expect(workflow).toContain(
      '"https://api.render.com/v1/services/$service_id/deploys"',
    );
    expect(workflow).toContain("deadline=$((SECONDS + 900))");
    expect(workflow).toContain('length == 3 and all(.status == "live")');
    expect(workflow).toContain("deployment-result.json");
  });

  it("opens the global kill switch only after explicit confirmation", () => {
    expect(workflow).toContain("open_global_emergency:");
    expect(workflow).toContain("default: false");
    expect(workflow).toContain('process.env.OPEN_GLOBAL_EMERGENCY === "true"');
    expect(workflow).toContain('"emergency",');
    expect(workflow).toContain('"global",');
    expect(workflow).toContain('"open",');
    expect(workflow).toContain("emergency-control-result.json");
  });
});
