import { describe, expect, it } from "vitest";
import {
  buildTrustedRefs,
  parseArgs,
  resolveActionRef,
  waitForDeploys,
} from "./sync-render-action-ref.mjs";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const shaC = "c".repeat(40);

describe("sync-render-action-ref", () => {
  it("rejects waiting when deploys are disabled", () => {
    expect(() => parseArgs(["--wait", "--no-deploy"])).toThrow(
      "--wait requires deploys",
    );
  });

  it("keeps explicit full SHA action refs pinned", async () => {
    await expect(
      resolveActionRef({
        actionRef: `777Genius/Review-Router@${shaA.toUpperCase()}`,
        actionRepo: "777genius/review-router",
        branch: "main",
      }),
    ).resolves.toBe(`777genius/review-router@${shaA}`);
  });

  it("keeps explicit hosted channel refs as channels", async () => {
    await expect(
      resolveActionRef({
        actionRef: "777genius/review-router@main",
        actionRepo: "777genius/review-router",
        branch: "main",
      }),
    ).resolves.toBe("777genius/review-router@main");
    await expect(
      resolveActionRef({
        actionRef: "777genius/review-router@v1",
        actionRepo: "777genius/review-router",
        branch: "main",
      }),
    ).resolves.toBe("777genius/review-router@v1");
  });

  it("uses the hosted main branch ref by default", async () => {
    await expect(
      resolveActionRef({
        actionRef: "",
        actionRepo: "777genius/review-router",
        branch: "main",
      }),
    ).resolves.toBe("777genius/review-router@main");
  });

  it("builds a bounded trusted ref window from current production refs", () => {
    expect(
      buildTrustedRefs({
        nextActionRef: `777genius/review-router@${shaA}`,
        currentActionRefs: [`777genius/review-router@${shaB}`],
        currentAllowedActionRefs: [
          `777genius/review-router@${shaC},777genius/review-router@${shaB}`,
        ],
        allowlistWindow: 2,
      }),
    ).toEqual([
      `777genius/review-router@${shaA}`,
      `777genius/review-router@${shaB}`,
    ]);
  });

  it("fails when a trusted ref belongs to another action repository", () => {
    expect(() =>
      buildTrustedRefs({
        nextActionRef: `777genius/review-router@${shaA}`,
        currentActionRefs: [`other/review-router@${shaB}`],
        currentAllowedActionRefs: [],
        allowlistWindow: 2,
      }),
    ).toThrow("does not use the same action repository");
  });

  it("waits until all Render deploys become live", async () => {
    const seen: string[] = [];
    const client = {
      async getDeploy(_serviceId: string, deployId: string) {
        seen.push(deployId);
        return { id: deployId, status: "live" };
      },
    };

    await expect(
      waitForDeploys(
        client,
        [
          { service: { id: "svc-a", name: "web" }, id: "dep-a" },
          { service: { id: "svc-b", name: "api" }, id: "dep-b" },
        ],
        { waitTimeoutMs: 100, pollIntervalMs: 1 },
      ),
    ).resolves.toBeUndefined();
    expect(seen).toEqual(["dep-a", "dep-b"]);
  });
});
