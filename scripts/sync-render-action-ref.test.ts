import { mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHostedPoolActionRelease } from "../packages/platform/config/src/index";
import { validateHostedActionReleaseReadiness } from "./lib/hosted-action-release-readiness.mjs";
import {
  actionRefEnvUpdates,
  allowedActionRefsEnvValue,
  assertSafeActionRefSelection,
  assertExactRotationCohort,
  buildTrustedRefs,
  buildTrustedRefWindows,
  executeRotationPhase,
  loadVerifiedActionRelease,
  parseArgs,
  parseVerifiedActionReleaseDescriptor,
  readInstallerDescriptor,
  resolveExactRotationServices,
  rotationOverlapUpdates,
  resolveActionRef,
  waitForDeploys,
} from "./sync-render-action-ref.mjs";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const shaC = "c".repeat(40);
const shaD = "d".repeat(40);

function verifiedReleaseInput(sha: string, version = "v1.0.141") {
  return {
    installerDescriptor: {
      url: `https://raw.githubusercontent.com/777genius/review-router/${sha}/scripts/seed-codex-rotating-auth.sh`,
      version,
      sha256: "e".repeat(64),
    },
    hostedRelease: {
      tag: version,
      sha,
      distSha256: "f".repeat(64),
    },
  };
}

function releaseDescriptorBytes(sha: string, version = "v1.0.141") {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: "reviewrouter.codex-rotating-action-release-descriptor.v2",
      url: `https://raw.githubusercontent.com/777genius/review-router/${sha}/scripts/seed-codex-rotating-auth.sh`,
      version,
      sha256: "e".repeat(64),
      actionRef: `777genius/review-router@${sha}`,
      actionRelease: {
        tag: version,
        sha,
        distSha256: "f".repeat(64),
      },
      reseed: {
        url: `https://raw.githubusercontent.com/777genius/review-router/${sha}/scripts/reseed-codex-rotating-auth.sh`,
        sha256: "d".repeat(64),
      },
    }),
  );
}

function serviceValues(sha: string, version: string) {
  const ref = `777genius/review-router@${sha}`;
  const release = verifiedReleaseInput(sha, version);
  return new Map([
    ["REVIEW_ROUTER_ACTION_REF", ref],
    ["REVIEW_ROUTER_ALLOWED_ACTION_REFS", ref],
    ["REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF", ref],
    ["REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS", ref],
    [
      "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL",
      release.installerDescriptor.url,
    ],
    [
      "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION",
      release.installerDescriptor.version,
    ],
    [
      "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256",
      release.installerDescriptor.sha256,
    ],
    ["REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG", release.hostedRelease.tag],
    ["REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA", release.hostedRelease.sha],
    [
      "REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256",
      release.hostedRelease.distSha256,
    ],
  ]);
}

function rotationContext() {
  const events: string[] = [];
  const claims: unknown[] = [];
  return {
    releaseTag: "v1.0.141",
    operationId: "rotation-test-operation",
    scope: {
      ownerId: "owner-1",
      projectId: "project-1",
      environmentId: "env-1",
    },
    authority: {
      events,
      claims,
      async acquireOperation(input: unknown) {
        events.push("acquire");
        claims.push(input);
        return { receipt: {}, request: {} };
      },
      async complete() {
        events.push("complete");
      },
      async markRecoveryRequired() {
        events.push("recovery");
      },
    },
  };
}

describe("sync-render-action-ref", () => {
  it("forces live deployment verification for phased rotations", () => {
    const args = parseArgs([
      "--action-ref",
      `777genius/review-router@${shaB}`,
      "--rotation-phase",
      "stage",
      "--release-tag",
      "v1.0.141",
      "--operation-id",
      "rotation-test-0001",
    ]);
    expect(args.wait).toBe(true);
    expect(args.deploy).toBe(true);
    expect(() =>
      parseArgs([
        "--action-ref",
        `777genius/review-router@${shaB}`,
        "--rotation-phase",
        "stage",
        "--release-tag",
        "v1.0.141",
        "--operation-id",
        "rotation-test-0002",
        "--no-deploy",
      ]),
    ).toThrow("requires deploys");
  });

  it.each(["stage", "promote", "retire"])(
    "rejects a partial production cohort for %s before any client work",
    (phase) => {
      const args = [
        "--action-ref",
        `777genius/review-router@${shaB}`,
        "--rotation-phase",
        phase,
        "--services",
        "reviewrouter-web,reviewrouter-api",
      ];
      if (phase === "retire") {
        args.push("--retire-action-ref", `777genius/review-router@${shaA}`);
      }
      expect(() => parseArgs(args)).toThrow("exact production cohort");
    },
  );

  it("accepts the exact production cohort in any order and rejects duplicates or extras", () => {
    expect(() =>
      assertExactRotationCohort([
        "reviewrouter-worker",
        "reviewrouter-web",
        "reviewrouter-api",
      ]),
    ).not.toThrow();
    expect(() =>
      assertExactRotationCohort([
        "reviewrouter-web",
        "reviewrouter-api",
        "reviewrouter-api",
      ]),
    ).toThrow("exact production cohort");
    expect(() =>
      assertExactRotationCohort([
        "reviewrouter-web",
        "reviewrouter-api",
        "reviewrouter-worker",
        "reviewrouter-preview",
      ]),
    ).toThrow("exact production cohort");
  });

  it("rejects duplicate names and wrong Render environments before mutation", () => {
    const scope = {
      ownerId: "owner-1",
      projectId: "project-1",
      environmentId: "env-1",
    };
    const service = (id: string, name: string, environmentId = "env-1") => ({
      id,
      name,
      ownerId: "owner-1",
      projectId: "project-1",
      environmentId,
    });
    expect(() =>
      resolveExactRotationServices(
        [
          service("one", "reviewrouter-web"),
          service("two", "reviewrouter-web"),
        ],
        ["reviewrouter-web"],
        scope,
      ),
    ).toThrow("missing or ambiguous");
    expect(() =>
      resolveExactRotationServices(
        [service("one", "reviewrouter-web", "env-wrong")],
        ["reviewrouter-web"],
        scope,
      ),
    ).toThrow("missing or ambiguous");
    expect(
      resolveExactRotationServices(
        [service("one", "reviewrouter-web")],
        ["reviewrouter-web"],
        scope,
      ),
    ).toHaveLength(1);
  });

  it("rejects the unsafe legacy one-pass immutable ref sync", () => {
    expect(() =>
      assertSafeActionRefSelection(`777genius/review-router@${shaB}`, ""),
    ).toThrow("one-pass A -> B sync is unsafe");
    expect(() =>
      assertSafeActionRefSelection("777genius/review-router@main", ""),
    ).not.toThrow();
  });

  it("accepts only an externally observed exact immutable B release tuple", () => {
    const input = {
      bytes: releaseDescriptorBytes(shaB),
      nextActionRef: `777genius/review-router@${shaB}`,
      releaseTag: "v1.0.141",
      observedActionTagSha: shaB,
      observedDistSha256: "f".repeat(64),
      observedSeedSha256: "e".repeat(64),
      observedReseedSha256: "d".repeat(64),
    };
    expect(parseVerifiedActionReleaseDescriptor(input)).toEqual(
      verifiedReleaseInput(shaB),
    );
    expect(() =>
      parseVerifiedActionReleaseDescriptor({
        ...input,
        observedDistSha256: "0".repeat(64),
      }),
    ).toThrow("hosted Action release tuple mismatch");
  });

  it("attests a >1.3MB public dist/index.js independently from action-dist/index.cjs", () => {
    const publicBundle = Buffer.alloc(1_400_000, 7);
    const publicDigest = createHash("sha256")
      .update(publicBundle)
      .digest("hex");
    const seed = Buffer.from("seed");
    const reseed = Buffer.from("reseed");
    const descriptor = JSON.parse(releaseDescriptorBytes(shaB).toString());
    descriptor.actionRelease.distSha256 = publicDigest;
    descriptor.sha256 = createHash("sha256").update(seed).digest("hex");
    descriptor.reseed.sha256 = createHash("sha256")
      .update(reseed)
      .digest("hex");
    const requested: string[] = [];
    const result = loadVerifiedActionRelease(
      {
        releaseTag: "v1.0.141",
        nextActionRef: `777genius/review-router@${shaB}`,
      },
      {
        json(endpoint: string) {
          if (endpoint.includes("releases/tags"))
            return {
              draft: false,
              prerelease: false,
              tag_name: "v1.0.141",
              assets: [
                {
                  name: "reviewrouter-codex-rotating-installer-descriptor.json",
                  id: 1,
                },
              ],
            };
          return { sha: shaB };
        },
        bytes(endpoint: string) {
          requested.push(endpoint);
          if (endpoint.includes("releases/assets"))
            return Buffer.from(JSON.stringify(descriptor));
          if (endpoint.includes("dist/index.js")) return publicBundle;
          if (endpoint.includes("reseed-codex")) return reseed;
          if (endpoint.includes("seed-codex")) return seed;
          throw new Error(`unexpected endpoint ${endpoint}`);
        },
      },
    );
    expect(result.hostedRelease.distSha256).toBe(publicDigest);
    expect(
      requested.some((endpoint) => endpoint.includes("dist/index.js")),
    ).toBe(true);
    expect(
      requested.some((endpoint) => endpoint.includes("action-dist/index.cjs")),
    ).toBe(false);
  });

  it("rejects mismatched release metadata and retired extras before client reads", async () => {
    let reads = 0;
    const client = {
      async getEnvVar() {
        reads += 1;
        return "";
      },
    };
    const services = ["web", "api", "worker"].map((name) => ({
      id: `svc-${name}`,
      name,
    }));
    await expect(
      executeRotationPhase(client, services, {
        nextActionRef: `777genius/review-router@${shaB}`,
        rotationPhase: "stage",
        retireActionRef: "",
        ...verifiedReleaseInput(shaA),
        allowlistWindow: 4,
        extraAllowedActionRefs: [],
      }),
    ).rejects.toThrow("verified hosted Action release metadata is required");
    await expect(
      executeRotationPhase(client, services, {
        nextActionRef: `777genius/review-router@${shaB}`,
        rotationPhase: "retire",
        retireActionRef: `777genius/review-router@${shaA}`,
        ...verifiedReleaseInput(shaB),
        allowlistWindow: 4,
        extraAllowedActionRefs: [`777genius/review-router@${shaA}`],
      }),
    ).rejects.toThrow("cannot remain in extra allowed refs");
    expect(reads).toBe(0);
  });

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

  it("refuses to silently evict an existing ref from a legacy trust window", () => {
    expect(() =>
      buildTrustedRefs({
        nextActionRef: `777genius/review-router@${shaA}`,
        currentActionRefs: [`777genius/review-router@${shaB}`],
        currentAllowedActionRefs: [
          `777genius/review-router@${shaC},777genius/review-router@${shaB}`,
        ],
        allowlistWindow: 2,
      }),
    ).toThrow("refusing to evict an existing ref");
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
      allowlistWindow: 3,
    });

    expect(windows).toEqual({
      allowedActionRefs: [nextActionRef, `777genius/review-router@${shaB}`],
      rotatingActionRef: nextActionRef,
      rotatingAllowedActionRefs: [
        nextActionRef,
        `777genius/review-router@${shaC}`,
        `777genius/review-router@${shaD}`,
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
        value: `${nextActionRef},777genius/review-router@${shaC},777genius/review-router@${shaD}`,
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

  it("records durable recovery after a partially committed promote and never deploys it", async () => {
    const refA = `777genius/review-router@${shaA}`;
    const refB = `777genius/review-router@${shaB}`;
    const services = ["web", "api", "worker"].map((name) => ({
      id: `svc-${name}`,
      name,
    }));
    const values = new Map(
      services.map((service) => [service.id, serviceValues(shaA, "v1.0.140")]),
    );
    for (const service of services) {
      values
        .get(service.id)
        ?.set("REVIEW_ROUTER_ALLOWED_ACTION_REFS", `${refB},${refA}`);
      values
        .get(service.id)
        ?.set(
          "REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS",
          `${refB},${refA}`,
        );
    }
    const blockApiPrimary = true;
    const deploySnapshots: Array<{
      serviceId: string;
      rotatingPrimary: string;
      rotatingAllowed: string;
      resolvedActionRef: string;
    }> = [];
    const client = {
      async getEnvVar(serviceId: string, key: string) {
        return values.get(serviceId)?.get(key) ?? "";
      },
      async setEnvVar(serviceId: string, key: string, value: string) {
        if (
          serviceId === "svc-api" &&
          key === "REVIEW_ROUTER_ACTION_REF" &&
          blockApiPrimary
        ) {
          throw new Error("injected partial failure");
        }
        values.get(serviceId)?.set(key, value);
      },
      async triggerDeploy(serviceId: string) {
        const serviceEnv = Object.fromEntries(values.get(serviceId) ?? []);
        expect(validateHostedActionReleaseReadiness(serviceEnv)).toEqual([]);
        deploySnapshots.push({
          serviceId,
          rotatingPrimary:
            values
              .get(serviceId)
              ?.get("REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF") ?? "",
          rotatingAllowed:
            values
              .get(serviceId)
              ?.get("REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS") ?? "",
          resolvedActionRef:
            resolveHostedPoolActionRelease(serviceEnv).actionRef,
        });
        return { id: `dep-${deploySnapshots.length}` };
      },
      async getDeploy(_serviceId: string, deployId: string) {
        return { id: deployId, status: "live" };
      },
    };
    const context = rotationContext();
    const input = {
      ...context,
      nextActionRef: refB,
      rotationPhase: "promote",
      retireActionRef: "",
      ...verifiedReleaseInput(shaB),
      allowlistWindow: 2,
      extraAllowedActionRefs: [],
      waitTimeoutMs: 100,
      pollIntervalMs: 1,
    };

    await expect(executeRotationPhase(client, services, input)).rejects.toThrow(
      "requires operator recovery",
    );
    expect(context.authority.events).toContain("recovery");
    expect(context.authority.claims[0]).toMatchObject({
      resourceId:
        "action-ref-rotation:owner-1:project-1:env-1:svc-api:svc-web:svc-worker",
    });
    expect(context.authority.events).not.toContain("complete");
    expect(deploySnapshots).toHaveLength(0);
    expect(values.get("svc-web")?.get("REVIEW_ROUTER_ACTION_REF")).toBe(refB);
    expect(values.get("svc-api")?.get("REVIEW_ROUTER_ACTION_REF")).toBe(refA);
  });

  it("preflights overlap capacity for every service before writing anything", async () => {
    const refA = `777genius/review-router@${shaA}`;
    const refB = `777genius/review-router@${shaB}`;
    const refC = `777genius/review-router@${shaC}`;
    const refD = `777genius/review-router@${shaD}`;
    const services = ["web", "api", "worker"].map((name) => ({
      id: `svc-${name}`,
      name,
    }));
    let writes = 0;
    const client = {
      async getEnvVar(serviceId: string, key: string) {
        if (key.endsWith("ACTION_REF")) return refA;
        return serviceId === "svc-worker" ? `${refA},${refC},${refD}` : refA;
      },
      async setEnvVar() {
        writes += 1;
      },
      async triggerDeploy() {
        throw new Error("must not deploy");
      },
      async getDeploy() {
        throw new Error("must not poll");
      },
    };

    await expect(
      executeRotationPhase(client, services, {
        ...rotationContext(),
        nextActionRef: refB,
        rotationPhase: "stage",
        retireActionRef: "",
        ...verifiedReleaseInput(shaB),
        allowlistWindow: 3,
        extraAllowedActionRefs: [],
        waitTimeoutMs: 100,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow("needs 4 trusted refs");
    expect(writes).toBe(0);
  });

  it("does not infer success or rollback after a committed PUT followed by a transient GET", async () => {
    const refB = `777genius/review-router@${shaB}`;
    const services = ["web", "api", "worker"].map((name) => ({
      id: `svc-${name}`,
      name,
    }));
    const values = new Map(
      services.map((service) => [service.id, serviceValues(shaA, "v1.0.140")]),
    );
    let transientKey = "";
    let deploys = 0;
    const client = {
      async getEnvVar(serviceId: string, key: string) {
        if (transientKey === `${serviceId}:${key}`) {
          transientKey = "";
          throw new Error("transient GET");
        }
        return values.get(serviceId)?.get(key) ?? "";
      },
      async setEnvVar(serviceId: string, key: string, value: string) {
        values.get(serviceId)?.set(key, value);
        transientKey = `${serviceId}:${key}`;
      },
      async triggerDeploy() {
        deploys += 1;
        return { id: "unexpected" };
      },
      async getDeploy() {
        return { status: "live" };
      },
    };
    const context = rotationContext();
    await expect(
      executeRotationPhase(client, services, {
        ...context,
        nextActionRef: refB,
        rotationPhase: "stage",
        retireActionRef: "",
        ...verifiedReleaseInput(shaB),
        allowlistWindow: 4,
        extraAllowedActionRefs: [],
        waitTimeoutMs: 100,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow("requires operator recovery");
    expect(context.authority.events).toContain("recovery");
    expect(context.authority.events).not.toContain("complete");
    expect(deploys).toBe(0);
    expect(
      values.get("svc-web")?.get("REVIEW_ROUTER_ALLOWED_ACTION_REFS"),
    ).toBe(`${refB},777genius/review-router@${shaA}`);
  });

  it("marks an ambiguous deploy request for durable recovery", async () => {
    const refB = `777genius/review-router@${shaB}`;
    const services = ["web", "api", "worker"].map((name) => ({
      id: `svc-${name}`,
      name,
    }));
    const values = new Map(
      services.map((service) => [service.id, serviceValues(shaA, "v1.0.140")]),
    );
    const client = {
      async getEnvVar(serviceId: string, key: string) {
        return values.get(serviceId)?.get(key) ?? "";
      },
      async setEnvVar(serviceId: string, key: string, value: string) {
        values.get(serviceId)?.set(key, value);
      },
      async triggerDeploy() {
        throw new Error("deploy response timeout after acceptance");
      },
      async getDeploy() {
        throw new Error("must not poll unknown deploy");
      },
    };
    const context = rotationContext();
    await expect(
      executeRotationPhase(client, services, {
        ...context,
        nextActionRef: refB,
        rotationPhase: "stage",
        retireActionRef: "",
        ...verifiedReleaseInput(shaB),
        allowlistWindow: 4,
        extraAllowedActionRefs: [],
        waitTimeoutMs: 100,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow("requires operator recovery");
    expect(context.authority.events).toEqual(["acquire", "recovery"]);
  });

  it("preserves concurrent C and marks partial stage for operator recovery", async () => {
    const refA = `777genius/review-router@${shaA}`;
    const refB = `777genius/review-router@${shaB}`;
    const refC = `777genius/review-router@${shaC}`;
    const services = ["web", "api", "worker"].map((name) => ({
      id: `svc-${name}`,
      name,
    }));
    const values = new Map(
      services.map((service) => [service.id, serviceValues(shaA, "v1.0.140")]),
    );
    let workerAllowedReads = 0;
    let deploys = 0;
    const client = {
      async getEnvVar(serviceId: string, key: string) {
        if (
          serviceId === "svc-worker" &&
          key === "REVIEW_ROUTER_ALLOWED_ACTION_REFS"
        ) {
          workerAllowedReads += 1;
          if (workerAllowedReads === 3) {
            values.get(serviceId)?.set(key, `${refA},${refC}`);
          }
        }
        return values.get(serviceId)?.get(key) ?? "";
      },
      async setEnvVar(serviceId: string, key: string, value: string) {
        values.get(serviceId)?.set(key, value);
      },
      async triggerDeploy() {
        deploys += 1;
        return { id: `unexpected-${deploys}` };
      },
      async getDeploy() {
        return { status: "live" };
      },
    };

    const context = rotationContext();
    await expect(
      executeRotationPhase(client, services, {
        ...context,
        nextActionRef: refB,
        rotationPhase: "stage",
        retireActionRef: "",
        ...verifiedReleaseInput(shaB),
        allowlistWindow: 3,
        extraAllowedActionRefs: [],
        waitTimeoutMs: 100,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow("requires operator recovery");
    expect(deploys).toBe(0);
    expect(context.authority.events).toContain("recovery");
    expect(
      values.get("svc-web")?.get("REVIEW_ROUTER_ALLOWED_ACTION_REFS"),
    ).toBe(`${refB},${refA}`);
    expect(
      values.get("svc-api")?.get("REVIEW_ROUTER_ALLOWED_ACTION_REFS"),
    ).toBe(`${refB},${refA}`);
    expect(
      values.get("svc-worker")?.get("REVIEW_ROUTER_ALLOWED_ACTION_REFS"),
    ).toBe(`${refA},${refC}`);
  });

  it("builds one exact trust union for a divergent service cohort", () => {
    const refA = `777genius/review-router@${shaA}`;
    const refB = `777genius/review-router@${shaB}`;
    const refC = `777genius/review-router@${shaC}`;
    const states = [
      {
        actionRef: refA,
        allowedActionRefs: refA,
        rotatingActionRef: refA,
        rotatingAllowedActionRefs: refA,
      },
      {
        actionRef: refA,
        allowedActionRefs: `${refA},${refC}`,
        rotatingActionRef: refA,
        rotatingAllowedActionRefs: `${refA},${refC}`,
      },
    ];
    const input = {
      nextActionRef: refB,
      allowlistWindow: 3,
      extraAllowedActionRefs: [],
      cohortStates: states,
    };
    expect(rotationOverlapUpdates(states[0], input)).toEqual(
      rotationOverlapUpdates(states[1], input),
    );
    expect(rotationOverlapUpdates(states[0], input)).toEqual([
      {
        key: "REVIEW_ROUTER_ALLOWED_ACTION_REFS",
        value: `${refB},${refA},${refC}`,
      },
      {
        key: "REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS",
        value: `${refB},${refA},${refC}`,
      },
    ]);
  });

  it("retires A only after every primary is B and keeps unrelated trusted refs", async () => {
    const refA = `777genius/review-router@${shaA}`;
    const refB = `777genius/review-router@${shaB}`;
    const refC = `777genius/review-router@${shaC}`;
    const services = ["web", "api", "worker"].map((name) => ({
      id: `svc-${name}`,
      name,
    }));
    const values = new Map(
      services.map((service) => {
        const serviceEnv = serviceValues(shaB, "v1.0.141");
        serviceEnv.set(
          "REVIEW_ROUTER_ALLOWED_ACTION_REFS",
          `${refB},${refA},${refC}`,
        );
        serviceEnv.set(
          "REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS",
          `${refB},${refA},${refC}`,
        );
        return [service.id, serviceEnv];
      }),
    );
    let deploySequence = 0;
    const client = {
      async getEnvVar(serviceId: string, key: string) {
        return values.get(serviceId)?.get(key) ?? "";
      },
      async setEnvVar(serviceId: string, key: string, value: string) {
        values.get(serviceId)?.set(key, value);
      },
      async triggerDeploy(serviceId: string) {
        deploySequence += 1;
        const serviceEnv = Object.fromEntries(values.get(serviceId) ?? []);
        expect(resolveHostedPoolActionRelease(serviceEnv).actionRef).toBe(refB);
        expect(validateHostedActionReleaseReadiness(serviceEnv)).toEqual([]);
        return { id: `dep-${serviceId}-${deploySequence}` };
      },
      async getDeploy(_serviceId: string, deployId: string) {
        return { id: deployId, status: "live" };
      },
    };
    await executeRotationPhase(client, services, {
      ...rotationContext(),
      nextActionRef: refB,
      rotationPhase: "retire",
      retireActionRef: refA,
      ...verifiedReleaseInput(shaB),
      allowlistWindow: 3,
      extraAllowedActionRefs: [],
      waitTimeoutMs: 100,
      pollIntervalMs: 1,
    });
    for (const service of services) {
      expect(
        values.get(service.id)?.get("REVIEW_ROUTER_ALLOWED_ACTION_REFS"),
      ).toBe(`${refB},${refC}`);
      expect(
        values
          .get(service.id)
          ?.get("REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS"),
      ).toBe(`${refB},${refC}`);
    }
  });
});
