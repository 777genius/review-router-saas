import { describe, expect, it } from "vitest";
import { OctokitOrgRulesetSetupGateway } from "../infrastructure/github/octokit-org-ruleset-setup-gateway.js";
import { buildGitHubOrgRulesetPayload } from "../domain/org-ruleset-provisioning.js";

describe("OctokitOrgRulesetSetupGateway", () => {
  it("maps missing organization admin permission to a safe probe code", async () => {
    const requester = new FakeRequester(() => {
      const error = new Error("forbidden") as Error & { status: number };
      error.status = 403;
      throw error;
    });
    const gateway = new OctokitOrgRulesetSetupGateway(requester);

    await expect(
      gateway.probeOrganizationRulesetAccess({
        organizationLogin: "agent-teams-ai",
      }),
    ).resolves.toMatchObject({
      ok: false,
      safeErrorCode: "org_admin_permission_required",
    });
    expect(requester.calls[0]?.parameters).toMatchObject({
      headers: { "X-GitHub-Api-Version": "2026-03-10" },
    });
  });

  it("maps unsupported rulesets probes to safe UI codes", async () => {
    const notFound = new FakeRequester(() => {
      const error = new Error("not found") as Error & { status: number };
      error.status = 404;
      throw error;
    });
    await expect(
      new OctokitOrgRulesetSetupGateway(
        notFound,
      ).probeOrganizationRulesetAccess({
        organizationLogin: "agent-teams-ai",
      }),
    ).resolves.toMatchObject({
      ok: false,
      safeErrorCode: "org_rulesets_not_supported",
    });

    const validation = new FakeRequester(() => {
      const error = new Error("validation") as Error & { status: number };
      error.status = 422;
      throw error;
    });
    await expect(
      new OctokitOrgRulesetSetupGateway(
        validation,
      ).probeOrganizationRulesetAccess({
        organizationLogin: "agent-teams-ai",
      }),
    ).resolves.toMatchObject({
      ok: false,
      safeErrorCode: "org_ruleset_permission_update_pending",
    });
  });

  it("updates an existing ruleset instead of creating duplicates", async () => {
    const requester = new FakeRequester((route) => {
      if (route === "GET /orgs/{org}/rulesets") {
        return { data: [{ id: 77, name: "ReviewRouter required workflow" }] };
      }
      if (route === "PUT /orgs/{org}/rulesets/{ruleset_id}") {
        return {
          data: {
            id: 77,
            name: "ReviewRouter required workflow",
            _links: {
              html: {
                href: "https://github.com/organizations/agent-teams-ai/settings/rules/77",
              },
            },
          },
        };
      }
      throw new Error(`unexpected route ${route}`);
    });
    const gateway = new OctokitOrgRulesetSetupGateway(requester);

    await expect(
      gateway.createOrUpdateOrganizationRuleset({
        organizationLogin: "agent-teams-ai",
        name: "ReviewRouter required workflow",
        payload: buildGitHubOrgRulesetPayload({
          enforcement: "evaluate",
          sourceWorkflow: {
            repositoryId: "1001",
            repositoryFullName: "agent-teams-ai/alpha",
            path: ".github/workflows/reviewrouter-required.yml",
            ref: "refs/heads/main",
          },
          targetSelection: {
            scope: "selected_repositories",
            repositoryIds: ["1001"],
          },
        }),
      }),
    ).resolves.toEqual({
      id: "77",
      url: "https://github.com/organizations/agent-teams-ai/settings/rules/77",
    });

    expect(requester.routes).toEqual([
      "GET /orgs/{org}/rulesets",
      "PUT /orgs/{org}/rulesets/{ruleset_id}",
    ]);
  });

  it("keeps source workflow writes idempotent when content is unchanged", async () => {
    const workflow = "name: ReviewRouter Required\n";
    const requester = new FakeRequester((route) => {
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        return {
          data: {
            type: "file",
            sha: "existing-sha",
            content: Buffer.from(workflow).toString("base64"),
          },
        };
      }
      throw new Error(`unexpected route ${route}`);
    });
    const gateway = new OctokitOrgRulesetSetupGateway(requester);

    await expect(
      gateway.writeSourceWorkflow({
        owner: "agent-teams-ai",
        repo: "alpha",
        branch: "main",
        path: ".github/workflows/reviewrouter-required.yml",
        content: workflow,
        message: "chore: add ReviewRouter required workflow",
      }),
    ).resolves.toEqual({ sha: "existing-sha" });
    expect(requester.routes).toEqual([
      "GET /repos/{owner}/{repo}/contents/{path}",
    ]);
  });
});

class FakeRequester {
  public readonly routes: string[] = [];
  public readonly calls: Array<{
    readonly route: string;
    readonly parameters: Record<string, unknown> | undefined;
  }> = [];

  constructor(
    private readonly handler: (
      route: string,
      parameters: Record<string, unknown> | undefined,
    ) => { readonly data: unknown },
  ) {}

  async request(route: string, parameters?: Record<string, unknown>) {
    this.routes.push(route);
    this.calls.push({ route, parameters });
    return this.handler(route, parameters);
  }
}
