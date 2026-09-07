import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  projectRepositorySetupStatus,
  type WorkflowProvisioningStatus,
} from "../domain/workflow-provisioning";

describe("workflow provisioning setup-status authority", () => {
  it.each([
    ["not_started", "not_configured"],
    ["setup_pr_open", "setup_pr_open"],
    ["configured", "configured"],
    ["failed", "needs_attention"],
  ] satisfies readonly (readonly [WorkflowProvisioningStatus, string])[])(
    "projects %s to %s",
    (workflowProvisioningStatus, expected) => {
      expect(
        projectRepositorySetupStatus({
          workflowProvisioningStatus,
          legacySetupStatus: "configured",
        }),
      ).toBe(expected);
    },
  );

  it("falls back to the legacy setup status when no provisioning row exists", () => {
    expect(
      projectRepositorySetupStatus({
        workflowProvisioningStatus: null,
        legacySetupStatus: "needs_attention",
      }),
    ).toBe("needs_attention");
  });

  it("keeps GitHub setup-status writers out of RepositoryConnection", () => {
    const sources = [
      "../infrastructure/prisma/prisma-workflow-provisioning-repository.ts",
      "../../../../../apps/api/src/github/prisma-setup-pull-request-merge-handler.ts",
      "../../../../../apps/web/app/dashboard/actions.ts",
    ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

    for (const source of sources) {
      expect(source).not.toContain("repositoryConnection.update");
      expect(source).not.toMatch(/repositoryConnection[\s\S]*setupStatus/);
    }
  });

  it("uses the shared projection in every setup-status read model", () => {
    const sources = [
      "../../../repo-health/src/infrastructure/prisma/prisma-repository-health-repository.ts",
      "../../../support-diagnostics/src/infrastructure/prisma/prisma-support-diagnostics-repository.ts",
      "../../../../../apps/web/app/dashboard/page.tsx",
      "../../../../../apps/web/app/api/dashboard/repositories/search/route.ts",
    ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

    for (const source of sources) {
      expect(source).toContain("projectRepositorySetupStatus");
    }
  });
});
