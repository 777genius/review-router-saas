import { Buffer } from "node:buffer";
import type {
  OrgRulesetPermissionProbeResult,
  OrgRulesetSetupGatewayPort,
  OrgRulesetWriteResult,
  SourceWorkflowWriteResult,
} from "../../application/ports/org-ruleset-setup-gateway-port";
import type { GitHubOrgRulesetPayload } from "../../domain/org-ruleset-provisioning";

type GitHubRequester = {
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<{ data: unknown }>;
};

type GitHubRulesetSummary = {
  readonly id: number;
  readonly name: string;
  readonly _links?: { readonly html?: { readonly href?: string } };
};

const githubRulesetsApiVersion = "2026-03-10";

export class OctokitOrgRulesetSetupGateway implements OrgRulesetSetupGatewayPort {
  constructor(private readonly octokit: GitHubRequester) {}

  async probeOrganizationRulesetAccess(input: {
    readonly organizationLogin: string;
  }): Promise<OrgRulesetPermissionProbeResult> {
    try {
      await this.requestRulesetsApi("GET /orgs/{org}/rulesets", {
        org: input.organizationLogin,
        per_page: 1,
        targets: "branch",
      });
      return { ok: true };
    } catch (error: unknown) {
      const status = getErrorStatus(error);
      if (status === 403) {
        if (isGitHubRulesetsPlanUpgradeError(error)) {
          return {
            ok: false,
            safeErrorCode: "org_rulesets_not_supported",
            safeErrorSummary:
              "GitHub organization rulesets are unavailable on this organization plan. Use per-repository setup PR fallback.",
          };
        }
        return {
          ok: false,
          safeErrorCode: "org_admin_permission_required",
          safeErrorSummary:
            "The installed GitHub App needs Organization Administration: write before ReviewRouter can create or update organization rulesets.",
        };
      }
      if (status === 404) {
        return {
          ok: false,
          safeErrorCode: "org_rulesets_not_supported",
          safeErrorSummary:
            "GitHub organization rulesets are unavailable for this installation, organization, or plan.",
        };
      }
      if (status === 422) {
        return {
          ok: false,
          safeErrorCode: "org_ruleset_permission_update_pending",
          safeErrorSummary:
            "GitHub rejected the ruleset probe. The App permission update may still need approval by an organization owner.",
        };
      }
      throw error;
    }
  }

  async writeSourceWorkflow(input: {
    readonly owner: string;
    readonly repo: string;
    readonly branch: string;
    readonly path: string;
    readonly content: string;
    readonly message: string;
  }): Promise<SourceWorkflowWriteResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.readRepositoryFile(input);
      if (existing.content === input.content) {
        return { sha: existing.sha };
      }

      try {
        const { data } = await this.octokit.request(
          "PUT /repos/{owner}/{repo}/contents/{path}",
          {
            owner: input.owner,
            repo: input.repo,
            path: input.path,
            branch: input.branch,
            ...(existing.sha ? { sha: existing.sha } : {}),
            message: input.message,
            content: Buffer.from(input.content).toString("base64"),
          },
        );
        return { sha: parseContentSha(data) };
      } catch (error: unknown) {
        if (attempt === 0 && [409, 422].includes(getErrorStatus(error))) {
          continue;
        }
        throw error;
      }
    }

    throw new Error("github_workflow_write_response_invalid");
  }

  async createOrUpdateOrganizationRuleset(input: {
    readonly organizationLogin: string;
    readonly name: string;
    readonly payload: GitHubOrgRulesetPayload;
  }): Promise<OrgRulesetWriteResult> {
    const existing = await this.findRulesetByName({
      organizationLogin: input.organizationLogin,
      name: input.name,
    });
    const route = existing
      ? "PUT /orgs/{org}/rulesets/{ruleset_id}"
      : "POST /orgs/{org}/rulesets";
    const { data } = await this.requestRulesetsApi(route, {
      org: input.organizationLogin,
      ...(existing ? { ruleset_id: existing.id } : {}),
      ...input.payload,
    });
    return parseRulesetWriteResult(data);
  }

  private async readRepositoryFile(input: {
    readonly owner: string;
    readonly repo: string;
    readonly branch: string;
    readonly path: string;
  }): Promise<{
    readonly sha: string | null;
    readonly content: string | null;
  }> {
    try {
      const { data } = await this.octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner: input.owner,
          repo: input.repo,
          path: input.path,
          ref: input.branch,
        },
      );
      return parseRepositoryFile(data);
    } catch (error: unknown) {
      if (getErrorStatus(error) === 404) {
        return { sha: null, content: null };
      }
      throw error;
    }
  }

  private async findRulesetByName(input: {
    readonly organizationLogin: string;
    readonly name: string;
  }): Promise<GitHubRulesetSummary | null> {
    for (let page = 1; page <= 10; page += 1) {
      const { data } = await this.requestRulesetsApi(
        "GET /orgs/{org}/rulesets",
        {
          org: input.organizationLogin,
          per_page: 100,
          page,
          targets: "branch",
        },
      );
      if (!Array.isArray(data)) {
        throw new Error("github_ruleset_response_invalid");
      }
      const rulesets = data.map(parseRulesetSummary);
      const match = rulesets.find((ruleset) => ruleset.name === input.name);
      if (match) return match;
      if (rulesets.length < 100) break;
    }
    return null;
  }

  private async requestRulesetsApi(
    route: string,
    parameters: Record<string, unknown>,
  ): Promise<{ data: unknown }> {
    return this.octokit.request(route, {
      ...parameters,
      headers: {
        "X-GitHub-Api-Version": githubRulesetsApiVersion,
      },
    });
  }
}

function parseRepositoryFile(data: unknown): {
  readonly sha: string | null;
  readonly content: string | null;
} {
  if (Array.isArray(data) || typeof data !== "object" || data === null) {
    return { sha: null, content: null };
  }
  const file = data as {
    readonly type?: unknown;
    readonly sha?: unknown;
    readonly content?: unknown;
  };
  if (file.type !== "file" || typeof file.sha !== "string") {
    return { sha: null, content: null };
  }
  return {
    sha: file.sha,
    content:
      typeof file.content === "string"
        ? Buffer.from(file.content.replaceAll("\n", ""), "base64").toString(
            "utf8",
          )
        : null,
  };
}

function parseContentSha(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const response = data as { readonly content?: unknown };
  if (typeof response.content !== "object" || response.content === null) {
    return null;
  }
  const content = response.content as { readonly sha?: unknown };
  return typeof content.sha === "string" ? content.sha : null;
}

function parseRulesetSummary(data: unknown): GitHubRulesetSummary {
  if (typeof data !== "object" || data === null) {
    throw new Error("github_ruleset_response_invalid");
  }
  const ruleset = data as {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly _links?: unknown;
  };
  if (typeof ruleset.id !== "number" || typeof ruleset.name !== "string") {
    throw new Error("github_ruleset_response_invalid");
  }
  return ruleset as GitHubRulesetSummary;
}

function parseRulesetWriteResult(data: unknown): OrgRulesetWriteResult {
  const ruleset = parseRulesetSummary(data);
  return {
    id: String(ruleset.id),
    url: ruleset._links?.html?.href ?? null,
  };
}

function getErrorStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : 0;
}

function isGitHubRulesetsPlanUpgradeError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : "";
  return /upgrade to github team|upgrade.*enterprise|rulesets.*unavailable/i.test(
    message,
  );
}
