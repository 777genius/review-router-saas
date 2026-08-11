import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexRotatingSetupManifest,
  renderCodexRotatingInstallerCommand,
} from "@reviewrouter/features-provider-setup";

const mocks = vi.hoisted(() => ({
  authorizeGitHubCliRepository: vi.fn(),
  issueCodexRotatingSetupForRepository: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock(
  "../../../../../src/server/github-cli-repository-authorization",
  () => ({
    authorizeGitHubCliRepository: mocks.authorizeGitHubCliRepository,
  }),
);
vi.mock("../../../../../src/server/codex-rotating-setup-command", () => ({
  issueCodexRotatingSetupForRepository:
    mocks.issueCodexRotatingSetupForRepository,
}));
vi.mock("../../../../../src/server/prisma", () => ({
  getPrisma: () => ({ repositoryConnection: { findFirst: mocks.findFirst } }),
}));

import { POST } from "./route";

const setupCommand = renderCodexRotatingInstallerCommand({
  manifest: buildCodexRotatingSetupManifest({
    repositoryFullName: "Padelapp-Club/monorepository",
    repositoryId: "1185393047",
    installerUrl: "https://reviewrouter.site/install/codex-rotating",
    installerVersion: "route-test",
    installerSha256: "a".repeat(64),
    now: new Date("2026-07-15T16:45:00.000Z"),
  }),
  setupManifestUrl:
    "https://reviewrouter.site/api/codex-rotating/setup-manifest",
  installerArguments: ["--force-reseed"],
});

describe("Codex rotating CLI setup command route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeGitHubCliRepository.mockResolvedValue({
      githubRepositoryId: "1185393047",
      fullName: "Padelapp-Club/monorepository",
    });
    mocks.findFirst.mockResolvedValue({
      id: "repo_1",
      workspaceId: "workspace_1",
      provider: "github",
      githubRepositoryId: 1185393047n,
      fullName: "Padelapp-Club/monorepository",
      selected: true,
      archived: false,
      installation: { status: "active" },
    });
    mocks.issueCodexRotatingSetupForRepository.mockResolvedValue({
      command: setupCommand,
      expiresAt: "2026-07-15T17:00:00.000Z",
      providerInstanceId: "codex-rotating:1185393047",
    });
  });

  it("authorizes with the request token and returns a fresh-login command", async () => {
    const response = await POST(request({ reuseCurrentAuth: false }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.authorizeGitHubCliRepository).toHaveBeenCalledWith({
      accessToken: "github-token-value",
      repositoryFullName: "Padelapp-Club/monorepository",
    });
    expect(mocks.issueCodexRotatingSetupForRepository).toHaveBeenCalledWith(
      expect.objectContaining({ installerArguments: ["--force-reseed"] }),
    );
    expect(body.command).toBe(setupCommand);
    expect(body.command).toContain(
      "REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL=https://reviewrouter.site/api/codex-rotating/setup-manifest",
    );
    expect(JSON.stringify(body)).not.toContain("github-token-value");
    expect(JSON.stringify(body)).not.toContain("REVIEWROUTER_CODEX_AUTH_JSON");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires an explicit flag before reusing dedicated local auth", async () => {
    const response = await POST(request({ reuseCurrentAuth: true }));

    expect(response.status).toBe(200);
    expect(mocks.issueCodexRotatingSetupForRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        installerArguments: ["--reuse-existing-auth-i-know-it-is-current"],
      }),
    );
  });

  it("rejects missing bearer auth before repository lookup", async () => {
    const response = await POST(
      new Request(
        "https://reviewrouter.site/api/codex-rotating/cli/setup-command",
        {
          method: "POST",
          body: JSON.stringify({
            repository: "Padelapp-Club/monorepository",
          }),
        },
      ),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "github_cli_token_required",
    });
    expect(mocks.authorizeGitHubCliRepository).not.toHaveBeenCalled();
  });

  it("reports an active provider setup as a retryable conflict", async () => {
    mocks.issueCodexRotatingSetupForRepository.mockRejectedValueOnce(
      new Error("codex_rotating_setup_in_progress"),
    );

    const response = await POST(request({ reuseCurrentAuth: false }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "codex_rotating_setup_in_progress",
    });
  });

  it("reports setup lock contention as a retryable conflict", async () => {
    mocks.issueCodexRotatingSetupForRepository.mockRejectedValueOnce(
      new Error("codex_rotating_setup_lock_failed"),
    );

    const response = await POST(request({ reuseCurrentAuth: false }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "codex_rotating_setup_lock_failed",
    });
  });

  it("returns the stable recovery-required conflict across a witness generation", async () => {
    mocks.issueCodexRotatingSetupForRepository.mockRejectedValueOnce(
      new Error("codex_rotating_setup_recovery_required"),
    );

    const response = await POST(request({ reuseCurrentAuth: false }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "codex_rotating_setup_recovery_required",
    });
  });

  it("returns an actionable unavailable response while issuance is quiesced", async () => {
    mocks.issueCodexRotatingSetupForRepository.mockRejectedValueOnce(
      new Error("codex_rotating_setup_issuance_quiesced"),
    );
    const response = await POST(request({ reuseCurrentAuth: false }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "codex_rotating_setup_issuance_quiesced",
    });
  });
});

function request(options: { readonly reuseCurrentAuth: boolean }): Request {
  return new Request(
    "https://reviewrouter.site/api/codex-rotating/cli/setup-command",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer github-token-value",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repository: "Padelapp-Club/monorepository",
        reuseCurrentAuth: options.reuseCurrentAuth,
      }),
    },
  );
}
