// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitLabConnectWizard } from "./gitlab-connect-wizard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("GitLabConnectWizard", () => {
  it("discovers, installs, and requests Codex seed command without forwarding the token", async () => {
    const fetchMock = mockGitLabWizardFetch({
      installResult: {
        installationId: "gitlab_install_1",
        namespacePath: "acme/platform",
        requested: 1,
        succeeded: 1,
        failed: 0,
        setupMergeRequests: [],
      },
    });

    render(<GitLabConnectWizard workspaceId="workspace_1" />);

    fireEvent.change(
      screen.getByLabelText("Paste your GitLab group or project URL"),
      {
        target: { value: "https://gitlab.com/acme/platform" },
      },
    );
    fireEvent.change(screen.getByLabelText("GitLab access token"), {
      target: { value: "glpat-test-secret" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Discover repositories" }),
    );

    expect(await screen.findByText("Select repositories")).toBeTruthy();
    expect(screen.getByText("acme/platform/api")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Install ReviewRouter" }),
    );

    expect(await screen.findByText("GitLab is connected")).toBeTruthy();
    expect(
      await screen.findByText(/Run this once from a trusted machine/i),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Connect another GitLab source" })
        .getAttribute("href"),
    ).toBe("/setup/gitlab?workspaceId=workspace_1");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/dashboard/gitlab/codex-command",
        expect.any(Object),
      );
    });

    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)),
    );
    expect(bodies[0]).toMatchObject({
      workspaceId: "workspace_1",
      sourceUrl: "https://gitlab.com/acme/platform",
      token: "glpat-test-secret",
    });
    expect(bodies[1]).toMatchObject({
      workspaceId: "workspace_1",
      selectedProjectIds: ["101"],
      token: "glpat-test-secret",
    });
    expect(bodies[2]).toEqual({
      workspaceId: "workspace_1",
      installationId: "gitlab_install_1",
    });
    expect(JSON.stringify(bodies[2])).not.toContain("glpat-test-secret");
  });

  it("shows setup MR action needed when ci_config_path cannot be changed directly", async () => {
    mockGitLabWizardFetch({
      installResult: {
        installationId: "gitlab_install_2",
        namespacePath: "acme/platform",
        requested: 1,
        succeeded: 1,
        failed: 0,
        setupMergeRequests: [
          {
            projectId: "101",
            mergeRequestUrl:
              "https://gitlab.com/acme/platform/api/-/merge_requests/8",
          },
        ],
      },
    });

    render(<GitLabConnectWizard workspaceId="workspace_1" />);

    fireEvent.change(
      screen.getByLabelText("Paste your GitLab group or project URL"),
      { target: { value: "https://gitlab.com/acme/platform" } },
    );
    fireEvent.change(screen.getByLabelText("GitLab access token"), {
      target: { value: "glpat-test-secret" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Discover repositories" }),
    );
    await screen.findByText("Select repositories");

    fireEvent.click(
      screen.getByRole("button", { name: "Install ReviewRouter" }),
    );

    expect(await screen.findByText("Action needed")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open setup MR for project #101" })
        .getAttribute("href"),
    ).toBe("https://gitlab.com/acme/platform/api/-/merge_requests/8");
  });

  it("returns to token input when install rejects the token", async () => {
    mockGitLabWizardFetch({
      installError: { code: "gitlab_api_error_403", status: 403 },
    });

    render(<GitLabConnectWizard workspaceId="workspace_1" />);

    fireEvent.change(
      screen.getByLabelText("Paste your GitLab group or project URL"),
      { target: { value: "https://gitlab.com/acme/platform" } },
    );
    fireEvent.change(screen.getByLabelText("GitLab access token"), {
      target: { value: "glpat-old-secret" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Discover repositories" }),
    );
    await screen.findByText("Select repositories");

    fireEvent.click(
      screen.getByRole("button", { name: "Install ReviewRouter" }),
    );

    expect(
      await screen.findByText(
        "GitLab refused the token. Check token scopes and permissions.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("GitLab access token")).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          "Paste your GitLab group or project URL",
        ) as HTMLInputElement
      ).value,
    ).toBe("https://gitlab.com/acme/platform");
  });

  it("prefills the source URL for an existing GitLab installation", () => {
    render(
      <GitLabConnectWizard
        workspaceId="workspace_1"
        initialSourceUrl="https://gitlab.example.com/acme/platform"
      />,
    );

    expect(
      (
        screen.getByLabelText(
          "Paste your GitLab group or project URL",
        ) as HTMLInputElement
      ).value,
    ).toBe("https://gitlab.example.com/acme/platform");
  });
});

function mockGitLabWizardFetch(input: {
  readonly installResult?: {
    readonly installationId: string;
    readonly namespacePath: string;
    readonly requested: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly setupMergeRequests: readonly {
      readonly projectId: string;
      readonly mergeRequestUrl: string;
    }[];
  };
  readonly installError?: {
    readonly code: string;
    readonly status: number;
  };
}) {
  const fetchMock = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      void init;
      const pathname = String(url);
      if (pathname === "/api/dashboard/gitlab/discover") {
        return Response.json({
          source: {
            inputPath: "acme/platform",
            resolvedKind: "group",
            baseUrl: "https://gitlab.com",
            parentGroupPath: "acme",
          },
          projects: [
            {
              projectId: "101",
              fullName: "acme/platform/api",
              name: "api",
              defaultBranch: "main",
              webUrl: "https://gitlab.com/acme/platform/api",
              visibility: "private",
              archived: false,
            },
          ],
        });
      }
      if (pathname === "/api/dashboard/gitlab/install") {
        if (input.installError) {
          return Response.json(
            { error: { code: input.installError.code } },
            { status: input.installError.status },
          );
        }
        return Response.json(input.installResult);
      }
      if (pathname === "/api/dashboard/gitlab/codex-command") {
        return Response.json({
          command:
            'export GITLAB_TOKEN="paste_token_here"\ncurl -fsSL https://reviewrouter.site/install/codex-gitlab | bash -s -- --confirm-write',
          secretName: "CODEX_AUTH_JSON",
          sendsSecretToReviewRouter: false,
          targetLabel: "GitLab group acme/platform",
        });
      }
      return Response.json(
        { error: { code: "unexpected_url" } },
        { status: 500 },
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
