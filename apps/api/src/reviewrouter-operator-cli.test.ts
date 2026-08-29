import { describe, expect, it, vi } from "vitest";
import {
  executeReviewRouterOperatorCli,
  parseArguments,
} from "./reviewrouter-operator-cli.js";

const credential = "cli-operator-credential-with-at-least-32-characters";

describe("ReviewRouter operator CLI", () => {
  it("sends an authenticated set request and returns only the result", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        result: {
          repository: "777genius/agent-teams-ai",
          reasoningEffort: "ultra",
          changed: true,
        },
      }),
    );

    const result = await executeReviewRouterOperatorCli(
      [
        "config",
        "set",
        "--repo",
        "777genius/agent-teams-ai",
        "--effort",
        "ultra",
      ],
      {
        REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL: credential,
        REVIEW_ROUTER_API_URL: "https://api.reviewrouter.site",
      },
      { fetchImpl },
    );

    expect(result).toMatchObject({
      repository: "777genius/agent-teams-ai",
      reasoningEffort: "ultra",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url.toString()).toBe(
      "https://api.reviewrouter.site/api/operator/v1/review-config",
    );
    expect(init).toMatchObject({
      method: "PATCH",
      redirect: "error",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      repository: "777genius/agent-teams-ai",
      provider: "github",
      effort: "ultra",
    });
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("reads the credential file and sends workspace-qualified get", async () => {
    const readFileImpl = vi.fn(async () =>
      JSON.stringify({
        apiUrl: "https://api.reviewrouter.site",
        credential,
      }),
    );
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        result: {
          repository: "Padelapp-Club/monorepository",
          source: "repository",
        },
      }),
    );

    await executeReviewRouterOperatorCli(
      [
        "config",
        "get",
        "--repo",
        "Padelapp-Club/monorepository",
        "--workspace",
        "padelapp",
      ],
      {},
      {
        fetchImpl,
        readFileImpl: readFileImpl as never,
        statImpl: (async () => ({
          isFile: () => true,
          mode: 0o100600,
        })) as never,
        homeDirectory: "/home/operator",
      },
    );

    expect(readFileImpl).toHaveBeenCalledWith(
      "/home/operator/.config/reviewrouter/operator.json",
      "utf8",
    );
    expect(fetchImpl.mock.calls[0]?.[0].toString()).toBe(
      "https://api.reviewrouter.site/api/operator/v1/review-config?repo=Padelapp-Club%2Fmonorepository&provider=github&workspace=padelapp",
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
    });
  });

  it("reads investigation status through the authenticated operator route", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        result: {
          investigationId: "investigation-1",
          state: "awaiting_critic",
          nextAction: "run_critic",
        },
      }),
    );

    const result = await executeReviewRouterOperatorCli(
      ["investigation", "status", "--investigation-id", "investigation-1"],
      {
        REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL: credential,
        REVIEW_ROUTER_API_URL: "https://api.reviewrouter.site",
      },
      { fetchImpl },
    );

    expect(result).toMatchObject({
      investigationId: "investigation-1",
      nextAction: "run_critic",
    });
    expect(fetchImpl.mock.calls[0]?.[0].toString()).toBe(
      "https://api.reviewrouter.site/api/operator/v1/review-investigations/investigation-1/status",
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("generates a promotion report using only a configured profile identity", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        result: {
          reportHash: "a".repeat(64),
          body: { decision: "blocked" },
        },
      }),
    );
    const argumentsList = [
      "investigation",
      "promotion-report",
      "--producer-release",
      "release-1",
      "--promotion-profile-id",
      "production",
      "--promotion-profile-version",
      "2026-08.v1",
    ];

    await executeReviewRouterOperatorCli(
      argumentsList,
      {
        REVIEW_ROUTER_INVESTIGATION_PROMOTION_CREDENTIAL: credential,
        REVIEW_ROUTER_API_URL: "https://api.reviewrouter.site",
      },
      { fetchImpl },
    );

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url.toString()).toBe(
      "https://api.reviewrouter.site/api/operator/v1/review-investigation-promotion-reports",
    );
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toEqual({
      requestVersion: "review-investigation-promotion-request.v3",
      producerReleaseId: "release-1",
      profile: {
        id: "production",
        version: "2026-08.v1",
      },
    });

    await expect(
      executeReviewRouterOperatorCli(
        [...argumentsList, "--min-seeded-samples", "1"],
        {
          REVIEW_ROUTER_INVESTIGATION_PROMOTION_CREDENTIAL: credential,
          REVIEW_ROUTER_API_URL: "https://api.reviewrouter.site",
        },
        { fetchImpl },
      ),
    ).rejects.toThrow("reviewrouter_operator_option_unknown");
  });

  it("rejects duplicate, unknown, insecure, and invalid options locally", async () => {
    expect(() =>
      parseArguments(["config", "get", "--repo", "a/b", "--repo", "c/d"]),
    ).toThrow("reviewrouter_operator_option_invalid");
    await expect(
      executeReviewRouterOperatorCli(
        ["config", "get", "--repo", "a/b", "--effort", "high"],
        {
          REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL: credential,
          REVIEW_ROUTER_API_URL: "https://api.reviewrouter.site",
        },
      ),
    ).rejects.toThrow("reviewrouter_operator_option_unknown");
    await expect(
      executeReviewRouterOperatorCli(
        [
          "config",
          "set",
          "--repo",
          "a/b",
          "--effort",
          "ultra",
          "--api-url",
          "http://reviewrouter.site",
        ],
        {
          REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL: credential,
          REVIEW_ROUTER_API_URL: "https://api.reviewrouter.site",
        },
      ),
    ).rejects.toThrow("reviewrouter_operator_api_url_invalid");
  });

  it("returns a sanitized API error without response details or credential", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: {
            code: "repository_ambiguous",
            detail: `sensitive ${credential}`,
          },
        },
        { status: 409 },
      ),
    );

    const error = await executeReviewRouterOperatorCli(
      ["config", "get", "--repo", "777genius/example"],
      {
        REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL: credential,
        REVIEW_ROUTER_API_URL: "https://api.reviewrouter.site",
      },
      { fetchImpl },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "reviewrouter_operator_api_error:409:repository_ambiguous",
    );
    expect((error as Error).message).not.toContain(credential);
  });

  it("rejects a profile readable by other users", async () => {
    await expect(
      executeReviewRouterOperatorCli(
        ["config", "get", "--repo", "777genius/example"],
        {},
        {
          statImpl: (async () => ({
            isFile: () => true,
            mode: 0o100644,
          })) as never,
          readFileImpl: (async () =>
            JSON.stringify({
              apiUrl: "https://api.reviewrouter.site",
              credential,
            })) as never,
          homeDirectory: "/home/operator",
        },
      ),
    ).rejects.toThrow("reviewrouter_operator_profile_permissions_invalid");
  });
});
