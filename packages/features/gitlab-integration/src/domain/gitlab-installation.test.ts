import { describe, expect, it } from "vitest";
import {
  buildGitLabCiConfigPath,
  renderGitLabReviewRouterControlCiConfig,
  renderGitLabReviewRouterSetupInclude,
} from "./gitlab-installation";

describe("GitLab installation domain helpers", () => {
  it("builds custom CI config paths for a control project", () => {
    expect(
      buildGitLabCiConfigPath({
        controlProjectPath: "reviewrouter/control",
        configPath: ".gitlab/reviewrouter.yml",
        ref: "main",
      }),
    ).toBe(".gitlab/reviewrouter.yml@reviewrouter/control:main");
  });

  it("renders a small setup include for fallback merge requests", () => {
    expect(
      renderGitLabReviewRouterSetupInclude({
        controlProjectPath: "reviewrouter/control",
        configPath: ".gitlab/reviewrouter.yml",
        ref: "main",
      }),
    ).toBe(
      [
        "include:",
        '  - project: "reviewrouter/control"',
        '    file: "/.gitlab/reviewrouter.yml"',
        '    ref: "main"',
        "",
      ].join("\n"),
    );
  });

  it("renders the control-project GitLab CI runtime config", () => {
    const config = renderGitLabReviewRouterControlCiConfig({
      runtimeImage: "registry.example.com/reviewrouter/gitlab-runtime:v1",
    });

    expect(config).toContain("reviewrouter:review:");
    expect(config).toContain(
      'image: "registry.example.com/reviewrouter/gitlab-runtime:v1"',
    );
    expect(config).toContain("id_tokens:");
    expect(config).toContain("aud: $REVIEWROUTER_ID_TOKEN_AUDIENCE");
    expect(config).toContain("reviewrouter-gitlab-review");
    expect(config).toContain("reviewrouter-findings.json");
  });

  it("rejects unsafe control project paths", () => {
    expect(() =>
      buildGitLabCiConfigPath({
        controlProjectPath: "reviewrouter\ncontrol",
      }),
    ).toThrow("gitlab_control_project_path_invalid");
  });
});
