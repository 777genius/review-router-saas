import { describe, expect, it } from "vitest";
import { parseGitLabSourceUrl } from "./gitlab-source-url";

describe("parseGitLabSourceUrl", () => {
  it("normalizes GitLab group and subgroup paths", () => {
    expect(
      parseGitLabSourceUrl({
        value: "https://gitlab.com/acme/platform/",
      }),
    ).toEqual({
      baseUrl: "https://gitlab.com",
      path: "acme/platform",
    });

    expect(
      parseGitLabSourceUrl({
        value: "acme/platform/backend",
      }),
    ).toEqual({
      baseUrl: "https://gitlab.com",
      path: "acme/platform/backend",
    });
  });

  it("accepts project URLs and strips GitLab workbench suffixes", () => {
    expect(
      parseGitLabSourceUrl({
        value: "https://gitlab.com/acme/platform/api/-/merge_requests/8",
      }),
    ).toEqual({
      baseUrl: "https://gitlab.com",
      path: "acme/platform/api",
    });
  });

  it("supports a configured GitLab base URL", () => {
    expect(
      parseGitLabSourceUrl({
        value: "platform/api",
        defaultBaseUrl: "https://gitlab.example.com/",
      }),
    ).toEqual({
      baseUrl: "https://gitlab.example.com",
      path: "platform/api",
    });
  });

  it("rejects invalid or unsupported URLs before GitLab API calls", () => {
    expect(() =>
      parseGitLabSourceUrl({ value: "https://example.com/acme/api" }),
    ).toThrow("gitlab_source_url_host_unsupported");

    expect(() => parseGitLabSourceUrl({ value: "" })).toThrow(
      "gitlab_source_url_required",
    );

    expect(() =>
      parseGitLabSourceUrl({ value: "https://gitlab.com/-/admin" }),
    ).toThrow("gitlab_source_url_path_invalid");

    expect(() =>
      parseGitLabSourceUrl({ value: "https://gitlab.com/acme/%" }),
    ).toThrow("gitlab_source_url_path_invalid");

    expect(() =>
      parseGitLabSourceUrl({ value: "https://gitlab.com/acme/%2E%2E/api" }),
    ).toThrow("gitlab_source_url_path_invalid");
  });
});
