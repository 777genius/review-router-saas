import { describe, expect, it } from "vitest";
import { repositorySourceUrl } from "./repository-source-url";

describe("repositorySourceUrl", () => {
  it("builds GitHub repository links", () => {
    expect(
      repositorySourceUrl({
        provider: "github",
        fullName: "777genius/review-router",
      }),
    ).toBe("https://github.com/777genius/review-router");
  });

  it("uses the stored GitLab source base URL", () => {
    expect(
      repositorySourceUrl({
        provider: "gitlab",
        fullName: "acme/platform/api",
        sourceBaseUrl: "https://gitlab.example.com",
      }),
    ).toBe("https://gitlab.example.com/acme/platform/api");
  });

  it("defaults GitLab links to gitlab.com when older rows have no base URL", () => {
    expect(
      repositorySourceUrl({
        provider: "gitlab",
        fullName: "acme/platform/api",
        sourceBaseUrl: null,
      }),
    ).toBe("https://gitlab.com/acme/platform/api");
  });

  it("rejects unsafe GitLab base URLs", () => {
    expect(
      repositorySourceUrl({
        provider: "gitlab",
        fullName: "acme/platform/api",
        sourceBaseUrl: "javascript:alert(1)",
      }),
    ).toBeNull();
  });

  it("rejects unsafe localhost schemes", () => {
    expect(
      repositorySourceUrl({
        provider: "gitlab",
        fullName: "acme/platform/api",
        sourceBaseUrl: "javascript://localhost/alert",
      }),
    ).toBeNull();
  });
});
