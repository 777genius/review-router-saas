import { beforeEach, describe, expect, it, vi } from "vitest";
import { OctokitReviewV2DispatchCapabilityInspector } from "./octokit-review-v2-dispatch-capability-inspector.js";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
}));

vi.mock("@octokit/app", () => ({
  App: vi.fn().mockImplementation(function App() {
    return { octokit: { auth: mocks.auth } };
  }),
}));

describe("OctokitReviewV2DispatchCapabilityInspector", () => {
  beforeEach(() => {
    mocks.auth.mockReset();
  });

  it("proves repository-scoped actions write capability", async () => {
    mocks.auth.mockResolvedValueOnce({
      token: "installation-token",
      expiresAt: "2026-07-23T12:00:00.000Z",
      permissions: { actions: "write" },
    });
    const inspector = createInspector();

    await expect(
      inspector.inspectReviewV2DispatchCapability({
        githubInstallationId: "130834037",
        githubRepositoryId: "1163183284",
      }),
    ).resolves.toEqual({ available: true });
    expect(mocks.auth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 130834037,
      repositoryIds: [1163183284],
      permissions: { actions: "write" },
    });
  });

  it("reports a denied installation permission as unavailable", async () => {
    mocks.auth.mockRejectedValueOnce(
      Object.assign(new Error("permission not granted"), { status: 422 }),
    );

    await expect(
      createInspector().inspectReviewV2DispatchCapability({
        githubInstallationId: "130834037",
        githubRepositoryId: "1163183284",
      }),
    ).resolves.toEqual({ available: false });
  });

  it("does not hide transient provider failures", async () => {
    mocks.auth.mockRejectedValueOnce(
      Object.assign(new Error("provider unavailable"), { status: 503 }),
    );

    await expect(
      createInspector().inspectReviewV2DispatchCapability({
        githubInstallationId: "130834037",
        githubRepositoryId: "1163183284",
      }),
    ).rejects.toThrow("provider unavailable");
  });
});

function createInspector() {
  return new OctokitReviewV2DispatchCapabilityInspector({
    appId: "123",
    privateKey: "private-key",
  });
}
