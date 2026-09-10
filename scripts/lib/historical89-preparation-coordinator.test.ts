import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  symlinkSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  provisionHistorical89Reader,
  createHistorical89Journal,
  createHistorical89Render,
  historical89BackendState,
  historical89JsonResult,
  submitHistorical89Transition,
} from "./historical89-preparation-coordinator.mjs";
import { runHistorical89Operation } from "../run-historical89-inplace-operation.mjs";
const directories: string[] = [];
const journalOf = () => {
  const directory = mkdtempSync(join(tmpdir(), "rr-historical89-journal-"));
  directories.push(directory);
  return createHistorical89Journal(directory);
};
afterEach(() =>
  directories
    .splice(0)
    .forEach((d) => rmSync(d, { recursive: true, force: true })),
);
const json = (value: unknown) => ({ rows: [{ value }] });
const backend = {
  systemIdentifier: "123",
  databaseOid: "16385",
  databaseName: "review_router_dimy",
  pid: 123,
  backendStart: "2026-09-09 12:00:00+00",
};

describe("historical89 durable preparation boundary", () => {
  it("rejects the null source registry before opening a DB, writing requests, or touching Render", async () => {
    const effect = vi.fn(() => {
      throw new Error("unexpected effect");
    });
    await expect(
      runHistorical89Operation({
        coordinator: { open: effect },
        openReader: effect,
        render: { getService: effect, suspend: effect },
        journal: { put: effect },
        request: {},
      }),
    ).rejects.toThrow("independent_review_missing");
    expect(effect).not.toHaveBeenCalled();
  });

  it("publishes immutable bytes and retains operation identity across a new journal instance", () => {
    const journal = journalOf();
    const request = {
      expectedRevision: 3,
      serviceId: "srv-worker",
      digest: "same-intent",
    };
    const pin = journal.put("intent.request", request);
    const reopened = createHistorical89Journal(journal.root);
    expect(
      reopened.once("intent.request", () => ({ expectedRevision: 4 })),
    ).toEqual(request);
    expect(reopened.put("intent.request", request)).toBe(pin);
    expect(() =>
      reopened.put("intent.request", { ...request, expectedRevision: 4 }),
    ).toThrow("durable_request_conflict");
    expect(() => reopened.put("../outside", {})).toThrow("journal_key");
  });

  it("preserves the exact request across a lost reply, checks backend start, and rejects stale-revision rewrites", async () => {
    const journal = journalOf();
    const request = { expectedRevision: 3, sql: "source-owned transition" };
    const client = {
      query: vi.fn(async (sql: unknown) =>
        typeof sql === "string" ? json(backend) : { rows: [] },
      ),
    };
    const effect = vi.fn(async () => {
      throw new Error("reply lost");
    });
    await expect(
      submitHistorical89Transition({
        client,
        journal,
        key: "intent",
        request,
        execute: effect,
      }),
    ).rejects.toThrow("reply lost");
    expect(journal.get("intent.request")).toEqual(request);
    expect(journal.get("intent.attempt-0.start").backend).toEqual(backend);
    expect(journal.get("intent.complete")).toBeUndefined();
    await expect(
      submitHistorical89Transition({
        client,
        journal,
        key: "intent",
        request: { ...request, expectedRevision: 4 },
        execute: effect,
      }),
    ).rejects.toThrow("durable_request_conflict");
    expect(effect).toHaveBeenCalledTimes(1);
    const recovered = await submitHistorical89Transition({
      client,
      journal,
      key: "intent",
      request,
      execute: async () => ({ revision: "4" }),
    });
    expect(recovered).toEqual({ revision: "4" });
    expect(journal.get("intent.request")).toEqual(request);
    expect(journal.get("intent.attempt-1.start").requestDigest).toBe(
      journal.get("intent.attempt-0.start").requestDigest,
    );
  });

  it("does not retry effects while the original backend is alive or unknown", async () => {
    for (const started of [backend.backendStart, null]) {
      const journal = journalOf();
      const client = {
        query: vi.fn(async (sql: unknown) =>
          typeof sql === "string" ? json(backend) : { rows: [{ started }] },
        ),
      };
      const execute = vi.fn(async () => {
        throw new Error("lost");
      });
      const args = {
        client,
        journal,
        key: "prepare",
        request: { expectedRevision: 1 },
        execute,
      };
      await expect(submitHistorical89Transition(args)).rejects.toThrow("lost");
      await expect(submitHistorical89Transition(args)).rejects.toThrow(
        "original_backend_unresolved",
      );
      expect(execute).toHaveBeenCalledTimes(1);
    }
    expect(
      await historical89BackendState(
        {
          query: async (sql: unknown) =>
            typeof sql === "string"
              ? json(backend)
              : { rows: [{ started: "new-backend" }] },
        },
        backend,
      ),
    ).toBe("terminated");
  });

  it("reads the source renderer's JSON before its trailing COMMIT response", () => {
    expect(
      historical89JsonResult([
        { rows: [{ lock: null }] },
        json({ revision: "1" }),
        { command: "COMMIT", rows: [] },
      ]),
    ).toEqual({ revision: "1" });
    expect(() =>
      historical89JsonResult([json({ first: true }), json({ second: true })]),
    ).toThrow("ambiguous_json_result");
  });

  it("records actual Render responses without authorization headers and treats 202 separately from suspension", async () => {
    const journal = journalOf();
    const token = "synthetic-test-token";
    const observed = {
      id: "srv-worker",
      ownerId: "own-test",
      type: "background_worker",
      autoDeploy: "no",
      suspended: "not_suspended",
      serviceDetails: { preDeployCommand: "" },
    };
    const transport = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith("/suspend") ? null : JSON.stringify(observed),
          {
            status: url.endsWith("/suspend") ? 202 : 200,
            headers: { "x-request-id": "request-123" },
          },
        ),
    );
    const render = createHistorical89Render({
      token,
      journal,
      serviceIds: ["srv-worker"],
      fetchImpl: transport,
    });
    await render.suspend("srv-worker");
    expect((await render.getService("srv-worker")).suspended).toBe(
      "not_suspended",
    );
    const records = journal.keys("provider-").map((key) => journal.get(key));
    expect(
      records.some(
        (r: any) => r.status === 202 && r.requestId === "request-123",
      ),
    ).toBe(true);
    expect(JSON.stringify(records)).not.toContain(token);
    expect(JSON.stringify(records)).not.toContain("Authorization");
    await expect(render.suspend("srv-outside")).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe("trusted reader credential channel", () => {
  const d = `sha256:${"a".repeat(64)}`;
  const identity = {
    operationId: "11111111-2222-3333-4444-555555555555",
    systemIdentifier: "123",
    databaseOid: "16385",
    databaseName: "review_router_dimy",
    sourceCommit: "a".repeat(40),
    artifactReference: d,
    approvalReference: d,
    baselineReference: d,
    fleetReference: d,
    serviceIds: ["srv-disposable"],
  };
  it.each(["logging", "database"])(
    "fails closed without disclosing credentials on %s failure",
    async (failure) => {
      const secret = "synthetic-reader-secret";
      const query = vi.fn(async (sql: any) => {
        if (typeof sql !== "string")
          throw new Error(`server included ${secret} ${sql.values[0]}`);
        if (sql.includes("AS parameters"))
          return {
            rows: [
              { parameters: failure === "logging" ? "-1" : "0", errors: "0" },
            ],
          };
        return json({ prepared: true });
      });
      await expect(
        provisionHistorical89Reader({ query }, identity, undefined, secret),
      ).rejects.toThrow(
        /^historical89_coordinator:reader_credential_provisioning_failed$/,
      );
      expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK;");
      const statements = query.mock.calls.map(([sql]) =>
        typeof sql === "string" ? sql : sql.text,
      );
      expect(JSON.stringify(statements)).not.toContain(secret);
      expect(JSON.stringify(query.mock.calls)).not.toContain(secret);
      if (failure === "logging")
        expect(query.mock.calls.every(([sql]) => typeof sql === "string")).toBe(
          true,
        );
      else
        expect(
          query.mock.calls.some(([sql]) =>
            sql.values?.[0].startsWith("SCRAM-SHA-256$"),
          ),
        ).toBe(true);
    },
  );
});

describe("native executing source closure", () => {
  it("binds an alternate checkout and transitive resolution while permitting data-only source registration", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const directory = mkdtempSync(join(tmpdir(), "rr-executing-source-"));
    directories.push(directory);
    const helper = "scripts/lib/historical89-preparation-coordinator.mjs";
    const cli = "scripts/run-historical89-inplace-operation.mjs";
    const source = readFileSync(join(root, helper), "utf8");
    const files = [
      ...source
        .match(/const executableFiles = Object.freeze\(\[([\s\S]*?)\]\);/u)![1]
        .matchAll(/"([^"]+)"/gu),
    ].map((m) => m[1]);
    for (const file of files) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      copyFileSync(join(root, file), join(directory, file));
    }
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git(["init", "--quiet"]);
    git(["add", "."]);
    git([
      "-c",
      "user.name=Synthetic Test",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Synthetic reviewed source",
    ]);
    const commit = git(["rev-parse", "HEAD"]);
    const tree = git(["rev-parse", "HEAD^{tree}"]);
    symlinkSync(
      join(root, "node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    const artifact = join(directory, "reviewed-artifact");
    copyFileSync(join(directory, cli), artifact);
    const digest = `sha256:${createHash("sha256").update(readFileSync(artifact)).digest("hex")}`;
    const request = { sourceCommit: commit, artifactPath: artifact };
    const identity = {
      sourceTree: tree,
      authorizedBinaryArtifactDigest: digest,
    };
    const script = `import { assertHistorical89ExecutingSource } from ${JSON.stringify(pathToFileURL(join(directory, helper)).href)};
      try { console.log(assertHistorical89ExecutingSource(${JSON.stringify(request)},${JSON.stringify(identity)})); }
      catch(error) { console.error(error.message); process.exitCode=1; }`;
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "--import",
          createRequire(import.meta.url).resolve("tsx"),
          "--input-type=module",
          "-e",
          script,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
        },
      );
    const clean = run();
    expect(clean.stderr).toBe("");
    expect(clean.status).toBe(0);
    expect(clean.stdout.trim()).toBe(digest);
    const admission = join(
      directory,
      "scripts/lib/render-historical89-admission.mjs",
    );
    const registration = {
      path: "review.json",
      digest,
      externalRecovery: { path: "recovery.json", digest },
    };
    writeFileSync(
      admission,
      readFileSync(admission, "utf8").replace(
        '"managed-historical89-in-place/v1": null,',
        `"managed-historical89-in-place/v1": ${JSON.stringify(registration)},`,
      ),
    );
    expect(run().status).toBe(0);
    const renderer = "scripts/lib/render-historical89-preparation-custody.mjs";
    writeFileSync(
      join(directory, renderer),
      readFileSync(join(directory, renderer), "utf8") +
        "\n// alternate dirty renderer\n",
    );
    expect(run().stderr).toContain("executable_closure");
    copyFileSync(join(root, renderer), join(directory, renderer));
    writeFileSync(
      join(directory, cli),
      readFileSync(join(directory, cli), "utf8") + "\n// alternate dirty CLI\n",
    );
    expect(run().stderr).toContain("executable_artifact");
    copyFileSync(join(root, cli), join(directory, cli));
    writeFileSync(
      join(
        directory,
        "packages/features/release-rollout/src/domain/trusted-rollout-evidence.js",
      ),
      'export * from "./trusted-rollout-evidence.ts";',
    );
    expect(run().stderr).toContain("executable_closure_resolution");
  }, 120_000);
});
