import { describe, expect, it, vi } from "vitest";
import {
  buildServiceEnv,
  disableAndVerifyPreDeployCommand,
  serviceDetails,
  triggerAndVerifyDeploy,
} from "./deploy-render-hosted-beta.mjs";

describe("Render hosted deploy hardening", () => {
  it("forces every cutover-sensitive flag dormant despite stale input", () => {
    const result = Object.fromEntries(
      buildServiceEnv({
        databaseUrl: "postgres://internal/db",
        privateKey: "private-key-not-logged",
        role: "api",
        webUrl: "https://reviewrouter.example",
        apiUrl: "https://api.reviewrouter.example",
        env: {
          GITHUB_APP_CLIENT_ID: "client",
          GITHUB_APP_CLIENT_SECRET: "secret",
          GITHUB_APP_ID: "1",
          GITHUB_APP_SLUG: "reviewrouter",
          GITHUB_WEBHOOK_SECRET: "secret",
          REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "1",
          REVIEW_ROUTER_CODEX_ROTATING_NEW_WORK_ADMISSION_ENABLED: "1",
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED: "1",
          REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED: "1",
          REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED: "1",
          REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED: "1",
        },
      }).map(({ key, value }) => [key, value]),
    );
    for (const key of [
      "REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH",
      "REVIEW_ROUTER_CODEX_ROTATING_NEW_WORK_ADMISSION_ENABLED",
      "REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED",
      "REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED",
      "REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED",
      "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED",
    ]) {
      expect(result[key], key).toBe("0");
    }
    expect(
      serviceDetails({ type: "web_service", startCommand: "start" }),
    ).toHaveProperty("preDeployCommand", null);
  });

  it("PATCHes an existing migration hook off and GET-verifies null", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ serviceDetails: { preDeployCommand: null } });
    await disableAndVerifyPreDeployCommand({ request } as never, {
      id: "srv-1",
      name: "api",
    });
    expect(request.mock.calls).toEqual([
      [
        "PATCH",
        "/services/srv-1",
        { serviceDetails: { preDeployCommand: null } },
      ],
      ["GET", "/services/srv-1"],
    ]);
  });

  it("aborts before deploy when the canonical null GET check fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        serviceDetails: { preDeployCommand: "pnpm db:migrate" },
      });
    await expect(
      disableAndVerifyPreDeployCommand({ request } as never, {
        id: "srv-1",
        name: "api",
      }),
    ).rejects.toThrow("preDeployCommand is not canonical null");
  });

  it.each([
    [
      "commit",
      "a".repeat(40),
      `sha256:${"c".repeat(64)}`,
      "resolved commit mismatch",
    ],
    [
      "image",
      "b".repeat(40),
      `sha256:${"d".repeat(64)}`,
      "resolved image digest mismatch",
    ],
  ])(
    "aborts on resolved %s mismatch",
    async (_kind, observedCommit, observedImage, message) => {
      const expectedCommit = "b".repeat(40);
      const expectedImage = `sha256:${"c".repeat(64)}`;
      const request = vi
        .fn()
        .mockResolvedValueOnce({ id: "dep-1" })
        .mockResolvedValueOnce({
          id: "dep-1",
          status: "live",
          commitId: observedCommit,
          imageDigest: observedImage,
        });
      await expect(
        triggerAndVerifyDeploy(
          { request } as never,
          { id: "srv-1", name: "api" },
          {
            commit: expectedCommit,
            imageDigest: expectedImage,
            maxAttempts: 1,
          },
        ),
      ).rejects.toThrow(message);
    },
  );

  it("waits for the resolved deploy identifier and exact immutable facts", async () => {
    const commit = "a".repeat(40);
    const imageDigest = `sha256:${"b".repeat(64)}`;
    const request = vi
      .fn()
      .mockResolvedValueOnce({ deploy: { id: "dep-1" } })
      .mockResolvedValueOnce({ id: "dep-1", status: "building" })
      .mockResolvedValueOnce({
        id: "dep-1",
        status: "live",
        commitId: commit,
        imageDigest,
      });
    const poll = vi.fn(async () => undefined);
    await expect(
      triggerAndVerifyDeploy(
        { request } as never,
        { id: "srv-1", name: "api" },
        { commit, imageDigest, poll, maxAttempts: 2 },
      ),
    ).resolves.toMatchObject({ id: "dep-1", commit, imageDigest });
    expect(poll).toHaveBeenCalledOnce();
  });

  it("aborts when Render does not return a deploy identifier", async () => {
    await expect(
      triggerAndVerifyDeploy(
        { request: vi.fn().mockResolvedValue({}) } as never,
        { id: "srv-1", name: "api" },
        {
          commit: "a".repeat(40),
          imageDigest: `sha256:${"b".repeat(64)}`,
        },
      ),
    ).rejects.toThrow("did not return a deploy id");
  });

  it("aborts on terminal Render status or an unresolved deploy", async () => {
    const terminal = vi
      .fn()
      .mockResolvedValueOnce({ id: "dep-1" })
      .mockResolvedValueOnce({ id: "dep-1", status: "build_failed" });
    await expect(
      triggerAndVerifyDeploy(
        { request: terminal } as never,
        { id: "srv-1", name: "api" },
        {
          commit: "a".repeat(40),
          imageDigest: `sha256:${"b".repeat(64)}`,
          maxAttempts: 1,
        },
      ),
    ).rejects.toThrow("deploy terminated as build_failed");

    const unresolved = vi
      .fn()
      .mockResolvedValueOnce({ id: "dep-2" })
      .mockResolvedValueOnce({ id: "dep-2", status: "building" });
    await expect(
      triggerAndVerifyDeploy(
        { request: unresolved } as never,
        { id: "srv-1", name: "api" },
        {
          commit: "a".repeat(40),
          imageDigest: `sha256:${"b".repeat(64)}`,
          poll: async () => undefined,
          maxAttempts: 1,
        },
      ),
    ).rejects.toThrow("deploy did not resolve");
  });
});
