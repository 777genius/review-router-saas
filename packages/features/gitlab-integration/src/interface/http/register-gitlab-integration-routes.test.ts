import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Clock } from "@reviewrouter/shared";
import type { GitLabActionSessionTokenServicePort } from "../../application/ports/gitlab-action-session-token-service-port";
import type { GitLabCiIdTokenVerifierPort } from "../../application/ports/gitlab-ci-id-token-verifier-port";
import type { GitLabInstallationPort } from "../../application/ports/gitlab-installation-port";
import type {
  GitLabMergeRequestPort,
  GitLabRepositoryPort,
} from "../../application/ports/gitlab-repository-port";
import type {
  GitLabActionSessionClaims,
  GitLabCiIdTokenClaims,
  GitLabMergeRequestIdentity,
  GitLabRepositoryContext,
} from "../../domain/gitlab-ci-identity";
import type {
  GitLabCiLintResult,
  GitLabCiVariableSpec,
  GitLabProjectInstallationSettings,
} from "../../domain/gitlab-installation";
import { registerGitLabIntegrationRoutes } from "./register-gitlab-integration-routes";

const fixedNow = new Date("2026-05-30T12:00:00.000Z");
const clock: Clock = { now: () => fixedNow };
const headSha = "a".repeat(40);

const claims: GitLabCiIdTokenClaims = {
  iss: "https://gitlab.com",
  sub: "project_path:group/project:ref_type:branch:ref:feature",
  aud: "reviewrouter",
  namespace_id: "12",
  namespace_path: "group",
  project_id: "123",
  project_path: "group/project",
  job_project_id: "123",
  job_project_path: "group/project",
  user_id: "7",
  user_login: "ilya",
  pipeline_id: "1001",
  pipeline_source: "merge_request_event",
  job_id: "2002",
  ref: "feature",
  ref_type: "branch",
  sha: headSha,
};

const repository: GitLabRepositoryContext = {
  workspaceId: "workspace_1",
  repositoryId: "repo_1",
  gitlabProjectId: "123",
  fullName: "group/project",
  owner: "group",
  selected: true,
  installationStatus: "active",
};

const mergeRequest: GitLabMergeRequestIdentity = {
  projectId: "123",
  mergeRequestIid: "5",
  headSha,
  sourceProjectId: "123",
  targetProjectId: "123",
  state: "opened",
};

class StaticVerifier implements GitLabCiIdTokenVerifierPort {
  async verify(): Promise<GitLabCiIdTokenClaims> {
    return claims;
  }
}

class StaticRepositories implements GitLabRepositoryPort {
  async findSelectedRepositoryByGitLabProjectId(): Promise<GitLabRepositoryContext> {
    return repository;
  }
}

class StaticMergeRequests implements GitLabMergeRequestPort {
  async getMergeRequest(): Promise<GitLabMergeRequestIdentity> {
    return mergeRequest;
  }
}

class StaticSessions implements GitLabActionSessionTokenServicePort {
  async sign(input: {
    readonly claims: GitLabActionSessionClaims;
    readonly expiresInSeconds: number;
    readonly issuedAt: Date;
  }) {
    expect(input.claims.provider).toBe("gitlab");
    return {
      token: "gitlab-session",
      expiresAt: new Date(
        input.issuedAt.getTime() + input.expiresInSeconds * 1000,
      ),
    };
  }

  async verify(): Promise<GitLabActionSessionClaims> {
    throw new Error("not_needed");
  }
}

class StaticInstallation implements GitLabInstallationPort {
  public variables: GitLabCiVariableSpec[] = [];
  public updatedCiConfigPath: string | null = null;

  async getProjectSettings(): Promise<GitLabProjectInstallationSettings> {
    return {
      projectId: "123",
      fullName: "group/project",
      defaultBranch: "main",
      ciConfigPath: null,
      canEditProjectSettings: true,
      canCreateMergeRequest: true,
    };
  }

  async lintCiConfig(): Promise<GitLabCiLintResult> {
    return { valid: true, errors: [] };
  }

  async updateProjectCiConfigPath(input: {
    readonly ciConfigPath: string;
  }): Promise<void> {
    this.updatedCiConfigPath = input.ciConfigPath;
  }

  async upsertCiVariable(input: {
    readonly variable: GitLabCiVariableSpec;
  }): Promise<void> {
    this.variables.push(input.variable);
  }

  async createSetupMergeRequest() {
    return {
      iid: "8",
      webUrl: "https://gitlab.com/group/project/-/merge_requests/8",
    };
  }
}

describe("registerGitLabIntegrationRoutes", () => {
  it("exchanges GitLab CI ID tokens through the GitLab route", async () => {
    const app = await createApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/gitlab/action/v1/session/exchange",
      payload: {
        idToken: "id-token",
        mergeRequestIid: "5",
        headSha,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      protocolVersion: 1,
      sessionToken: "gitlab-session",
      expiresAt: "2026-05-30T12:15:00.000Z",
      repository: "group/project",
    });
  });

  it("requires an admin bearer token before provisioning GitLab projects", async () => {
    const installation = new StaticInstallation();
    const app = await createApp({ installation, exchange: false });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/gitlab/install/v1/projects/123/provision",
      payload: provisionPayload(),
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(installation.updatedCiConfigPath).toBeNull();

    const authorized = await app.inject({
      method: "POST",
      url: "/api/gitlab/install/v1/projects/123/provision",
      headers: { authorization: "Bearer installer-admin" },
      payload: provisionPayload(),
    });

    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({
      mode: "ci_config_path",
      ciConfigPath: ".gitlab/reviewrouter.yml@reviewrouter/control:main",
      variablesConfigured: 2,
    });
    expect(installation.updatedCiConfigPath).toBe(
      ".gitlab/reviewrouter.yml@reviewrouter/control:main",
    );
  });

  it("does not expose provisioning when installation dependencies are absent", async () => {
    const app = await createApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/gitlab/install/v1/projects/123/provision",
      headers: { authorization: "Bearer installer-admin" },
      payload: provisionPayload(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "gitlab_installation_unavailable" },
    });
  });

  it("reports exchange unavailable without blocking install-only route setup", async () => {
    const app = await createApp({ exchange: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/gitlab/action/v1/session/exchange",
      payload: {
        idToken: "id-token",
        mergeRequestIid: "5",
        headSha,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "gitlab_exchange_unavailable" },
    });
  });

  it("returns the control project CI config behind the install admin bearer", async () => {
    const app = await createApp({
      exchange: false,
      installerAdminToken: "installer-admin",
    });

    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/gitlab/install/v1/control-ci-config",
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: "GET",
      url: "/api/gitlab/install/v1/control-ci-config?runtimeImage=registry.example.com%2Freviewrouter%2Fgitlab-runtime%3Av1",
      headers: { authorization: "Bearer installer-admin" },
    });

    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({
      protocolVersion: 1,
      path: ".gitlab/reviewrouter.yml",
    });
    expect(authorized.json().content).toContain("reviewrouter:review:");
    expect(authorized.json().content).toContain(
      "registry.example.com/reviewrouter/gitlab-runtime:v1",
    );
  });
});

async function createApp(
  input: {
    readonly installation?: GitLabInstallationPort | undefined;
    readonly exchange?: boolean | undefined;
    readonly installerAdminToken?: string | undefined;
  } = {},
) {
  const app = Fastify({ logger: false });
  const includeExchange = input.exchange ?? true;
  await registerGitLabIntegrationRoutes(app, {
    ...(includeExchange
      ? {
          exchange: {
            verifier: new StaticVerifier(),
            repositories: new StaticRepositories(),
            mergeRequests: new StaticMergeRequests(),
            sessions: new StaticSessions(),
          },
        }
      : {}),
    installation: input.installation,
    installerAdminToken:
      input.installerAdminToken ??
      (input.installation ? "installer-admin" : undefined),
    clock,
  });
  return app;
}

function provisionPayload() {
  return {
    controlProjectPath: "reviewrouter/control",
    controlProjectRef: "main",
    reviewRouterApiBaseUrl: "https://reviewrouter.example.com",
    variableTarget: { kind: "group", id: "12" },
  };
}
