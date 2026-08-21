import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionRefEnvUpdates,
  allowedActionRefsEnvValue,
  buildTrustedRefs,
  buildTrustedRefWindows,
  parseArgs,
  readInstallerDescriptor,
  resolveActionRef,
  waitForDeploys,
} from "./sync-render-action-ref.mjs";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const shaC = "c".repeat(40);
const shaD = "d".repeat(40);

describe("sync-render-action-ref", () => {
  it("rejects waiting when deploys are disabled", () => {
    expect(() => parseArgs(["--wait", "--no-deploy"])).toThrow(
      "--wait requires deploys",
    );
  });

  it("accepts additional full SHA refs for active pinned workflows", () => {
    expect(
      parseArgs([
        "--extra-allowed-action-ref",
        `777genius/review-router@${shaA},777genius/review-router@${shaB}`,
        "--extra-allowed-action-ref",
        `777genius/review-router@${shaC}`,
      ]).extraAllowedActionRefs,
    ).toEqual([
      `777genius/review-router@${shaA}`,
      `777genius/review-router@${shaB}`,
      `777genius/review-router@${shaC}`,
    ]);
  });

  it("rejects mutable extra allowed action refs", () => {
    expect(() =>
      parseArgs(["--extra-allowed-action-ref", "777genius/review-router@main"]),
    ).toThrow("--extra-allowed-action-ref must be owner/repo@40-character-sha");
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

  it("rolls an immutable ref into both general and rotating trust windows", () => {
    const nextActionRef = `777genius/review-router@${shaA}`;
    const windows = buildTrustedRefWindows({
      nextActionRef,
      currentActionRefs: [`777genius/review-router@${shaB}`],
      currentAllowedActionRefs: [],
      currentRotatingActionRefs: [`777genius/review-router@${shaC}`],
      currentRotatingAllowedActionRefs: [`777genius/review-router@${shaD}`],
      extraAllowedActionRefs: [],
      allowlistWindow: 2,
    });

    expect(windows).toEqual({
      allowedActionRefs: [nextActionRef, `777genius/review-router@${shaB}`],
      rotatingActionRef: nextActionRef,
      rotatingAllowedActionRefs: [
        nextActionRef,
        `777genius/review-router@${shaC}`,
      ],
    });
    const installerDescriptor = {
      url: `https://raw.githubusercontent.com/777genius/review-router/${shaA}/scripts/seed-codex-rotating-auth.sh`,
      version: "v1.0.127",
      sha256: shaD.repeat(2).slice(0, 64),
    };
    expect(
      actionRefEnvUpdates({
        nextActionRef,
        ...windows,
        installerDescriptor,
      }),
    ).toEqual([
      { key: "REVIEW_ROUTER_ACTION_REF", value: nextActionRef },
      {
        key: "REVIEW_ROUTER_ALLOWED_ACTION_REFS",
        value: `${nextActionRef},777genius/review-router@${shaB}`,
      },
      {
        key: "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF",
        value: nextActionRef,
      },
      {
        key: "REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS",
        value: `${nextActionRef},777genius/review-router@${shaC}`,
      },
      {
        key: "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL",
        value: installerDescriptor.url,
      },
      {
        key: "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION",
        value: installerDescriptor.version,
      },
      {
        key: "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256",
        value: installerDescriptor.sha256,
      },
    ]);
  });

  it("loads only an installer descriptor bound to the immutable Action ref", () => {
    const nextActionRef = `777genius/review-router@${shaA}`;
    const directory = mkdtempSync(join(tmpdir(), "reviewrouter-descriptor-"));
    const descriptorPath = join(directory, "descriptor.json");
    writeFileSync(
      descriptorPath,
      JSON.stringify({
        schemaVersion: "reviewrouter.codex-rotating-installer-descriptor.v1",
        actionRef: nextActionRef,
        url: `https://raw.githubusercontent.com/777genius/review-router/${shaA}/scripts/seed-codex-rotating-auth.sh`,
        version: "v1.0.127",
        sha256: shaD.repeat(2).slice(0, 64),
      }),
    );

    expect(
      readInstallerDescriptor({ path: descriptorPath, nextActionRef }),
    ).toEqual({
      url: `https://raw.githubusercontent.com/777genius/review-router/${shaA}/scripts/seed-codex-rotating-auth.sh`,
      version: "v1.0.127",
      sha256: shaD.repeat(2).slice(0, 64),
    });
    expect(() =>
      readInstallerDescriptor({
        path: descriptorPath,
        nextActionRef: `777genius/review-router@${shaB}`,
      }),
    ).toThrow("installer descriptor does not match the Action ref");
  });

  it("does not write a mutable ref into rotating workflow trust", () => {
    const nextActionRef = "777genius/review-router@main";
    const windows = buildTrustedRefWindows({
      nextActionRef,
      currentActionRefs: [],
      currentAllowedActionRefs: [],
      currentRotatingActionRefs: [`777genius/review-router@${shaA}`],
      currentRotatingAllowedActionRefs: [],
      extraAllowedActionRefs: [],
      allowlistWindow: 2,
    });

    expect(windows.rotatingActionRef).toBeNull();
    expect(windows.rotatingAllowedActionRefs).toEqual([]);
    expect(actionRefEnvUpdates({ nextActionRef, ...windows })).toEqual([
      { key: "REVIEW_ROUTER_ACTION_REF", value: nextActionRef },
    ]);
  });

  it("does not render an empty allowed refs env value", () => {
    expect(allowedActionRefsEnvValue([])).toBeNull();
    expect(
      allowedActionRefsEnvValue([
        `777genius/review-router@${shaA}`,
        `777genius/review-router@${shaB}`,
      ]),
    ).toBe(`777genius/review-router@${shaA},777genius/review-router@${shaB}`);
  });

  it("keeps explicit active workflow refs before older rollback refs", () => {
    expect(
      buildTrustedRefs({
        nextActionRef: `777genius/review-router@${shaA}`,
        extraAllowedActionRefs: [
          `777genius/review-router@${shaC}`,
          `777genius/review-router@${shaD}`,
        ],
        currentActionRefs: [`777genius/review-router@${shaB}`],
        currentAllowedActionRefs: [
          `777genius/review-router@${shaD},777genius/review-router@${shaB}`,
        ],
        allowlistWindow: 4,
      }),
    ).toEqual([
      `777genius/review-router@${shaA}`,
      `777genius/review-router@${shaC}`,
      `777genius/review-router@${shaD}`,
      `777genius/review-router@${shaB}`,
    ]);
  });

  it("fails when a trusted ref belongs to another action repository", () => {
    expect(() =>
      buildTrustedRefs({
        nextActionRef: `777genius/review-router@${shaA}`,
        extraAllowedActionRefs: [],
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
