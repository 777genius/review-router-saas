import { describe, expect, it } from "vitest";
import {
  ciProviderToScmProvider,
  ciRunIdentityKey,
  isCiProvider,
  isScmProvider,
  scmRepositoryIdentityKey,
} from "./index";

describe("scm identity helpers", () => {
  it("builds stable repository keys across providers", () => {
    expect(
      scmRepositoryIdentityKey({
        provider: "github",
        externalRepositoryId: "123",
      }),
    ).toBe("github:123");
    expect(
      scmRepositoryIdentityKey({
        provider: "gitlab",
        externalRepositoryId: "456",
      }),
    ).toBe("gitlab:456");
  });

  it("builds CI run keys without assuming GitHub run attempts", () => {
    expect(
      ciRunIdentityKey({
        provider: "github-actions",
        externalRepositoryId: "123",
        runId: "777",
        runAttempt: "2",
      }),
    ).toBe("github:123:github-actions:777:2");
    expect(
      ciRunIdentityKey({
        provider: "gitlab-ci",
        externalRepositoryId: "456",
        runId: "888",
      }),
    ).toBe("gitlab:456:gitlab-ci:888");
  });

  it("keeps provider parsing explicit", () => {
    expect(isScmProvider("github")).toBe(true);
    expect(isScmProvider("gitlab")).toBe(true);
    expect(isScmProvider("bitbucket")).toBe(false);
    expect(isCiProvider("gitlab-ci")).toBe(true);
    expect(ciProviderToScmProvider("gitlab-ci")).toBe("gitlab");
  });
});
