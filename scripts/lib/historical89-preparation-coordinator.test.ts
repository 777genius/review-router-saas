import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  symlinkSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  provisionHistorical89Reader,
  captureHistorical89RetainedBackup,
  verifyHistorical89RetainedBackup,
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
  it("rejects an invalid request before opening a DB, writing requests, or touching Render", async () => {
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
    ).rejects.toThrow("request_shape");
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
          /\/(?:suspend|resume)$/u.test(url) ? null : JSON.stringify(observed),
          {
            status: /\/(?:suspend|resume)$/u.test(url) ? 202 : 200,
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
    await render.resume("srv-worker");
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
    expect(transport).toHaveBeenCalledTimes(3);
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
    const admissionSource = join(
      directory,
      "scripts/lib/render-historical89-admission.mjs",
    );
    writeFileSync(
      admissionSource,
      readFileSync(admissionSource, "utf8").replace(
        /"managed-historical89-in-place\/v1": \{[\s\S]*?\n  \},/u,
        '"managed-historical89-in-place/v1": null,',
      ),
    );
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
    const identity = {
      sourceTree: tree,
      authorizedBinaryArtifactDigest: digest,
    };
    const run = (sourceCommit = commit) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          createRequire(import.meta.url).resolve("tsx"),
          "--input-type=module",
          "-e",
          `import { assertHistorical89ExecutingSource } from ${JSON.stringify(pathToFileURL(join(directory, helper)).href)};
            try { console.log(assertHistorical89ExecutingSource(${JSON.stringify({ sourceCommit, artifactPath: artifact })},${JSON.stringify(identity)})); }
            catch(error) { console.error(error.message); process.exitCode=1; }`,
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
    const admission = admissionSource;
    const registration = {
      path: "./render-historical89-reviewed-bundle.json",
      digest: `sha256:${createHash("sha256").update("reviewed bundle\n").digest("hex")}`,
    };
    writeFileSync(
      join(directory, "scripts/lib/render-historical89-reviewed-bundle.json"),
      "reviewed bundle\n",
    );
    writeFileSync(
      admission,
      readFileSync(admission, "utf8").replace(
        '"managed-historical89-in-place/v1": null,',
        `"managed-historical89-in-place/v1": ${JSON.stringify(registration)},`,
      ),
    );
    expect(run().status).toBe(0);
    git(["add", "scripts/lib/render-historical89-admission.mjs"]);
    git(["add", "scripts/lib/render-historical89-reviewed-bundle.json"]);
    git([
      "-c",
      "user.name=Synthetic Test",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Activate reviewed bundle",
    ]);
    const activationCommit = git(["rev-parse", "HEAD"]);
    const activated = run(activationCommit);
    expect(activated.status, activated.stderr).toBe(0);
    writeFileSync(
      admission,
      `${readFileSync(admission, "utf8")}\n// committed admission tamper\n`,
    );
    git(["add", admission]);
    git([
      "-c",
      "user.name=Synthetic Test",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Tamper admission executable",
    ]);
    expect(run(git(["rev-parse", "HEAD"])).stderr).toContain(
      "executable_source",
    );
    git(["reset", "--hard", activationCommit]);
    writeFileSync(
      join(directory, "scripts/lib/render-historical89-operation.mjs"),
      `${readFileSync(join(directory, "scripts/lib/render-historical89-operation.mjs"), "utf8")}\n// committed tamper\n`,
    );
    git(["add", "scripts/lib/render-historical89-operation.mjs"]);
    git([
      "-c",
      "user.name=Synthetic Test",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Tamper runtime",
    ]);
    expect(run(git(["rev-parse", "HEAD"])).stderr).toContain(
      "executable_source",
    );
    git(["reset", "--hard", activationCommit]);
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

describe("retained fast recovery backup", () => {
  it("encrypts a fresh custom dump, verifies its decrypted listing, and journals only ciphertext identity", async () => {
    const journal = journalOf();
    const execute = vi.fn((command: string, _args: string[], options: any) => {
      if (command === "pg_dump") {
        writeFileSync(options.stdio[1], "synthetic-custom-dump");
        return { status: 0 };
      }
      if (command === "gpg") {
        const output = _args[_args.indexOf("--output") + 1];
        if (_args.at(-1) === "/proc/self/fd/3")
          writeFileSync(output, readFileSync(options.stdio[3]));
        else copyFileSync(_args.at(-1)!, output);
        return { status: 0 };
      }
      return { status: 0, stdout: "; Archive created at synthetic time\n" };
    });
    const operationId = randomUUID();
    journal.put("identity", { operationId });
    const metadata = await captureHistorical89RetainedBackup({
      databaseUrl:
        "postgresql://user:secret@localhost:5432/database?sslmode=require",
      journal,
      operationId,
      retentionKey: "a".repeat(64),
      execute,
    });
    expect(metadata.format).toBe("postgresql-custom-gpg");
    directories.push(
      join(dirname(journal.root), `historical89-${operationId}.dump.gpg`),
    );
    expect(metadata.bytes).toBeGreaterThan(0);
    expect(metadata.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(journal.get("recovery")).toEqual(metadata);
    expect(await verifyHistorical89RetainedBackup(journal, metadata)).toEqual(
      metadata,
    );
    expect(JSON.stringify(execute.mock.calls)).not.toContain("secret");
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      "pg_dump",
      "gpg",
      "gpg",
      "pg_restore",
    ]);
  });
  it("removes plaintext and pending ciphertext when encryption fails", async () => {
    const journal = journalOf();
    const operationId = randomUUID();
    journal.put("identity", { operationId });
    const execute = vi.fn((command: string, _args: string[], options: any) => {
      if (command === "pg_dump") {
        writeFileSync(options.stdio[1], "synthetic-custom-dump");
        return { status: 0 };
      }
      return { status: 1 };
    });
    await expect(
      captureHistorical89RetainedBackup({
        databaseUrl: "postgresql://user:secret@localhost:5432/database",
        journal,
        operationId,
        retentionKey: "b".repeat(64),
        execute,
      }),
    ).rejects.toThrow("backup_encryption_failed");
    expect(journal.get("recovery")).toBeUndefined();
    expect(
      readdirSync(dirname(journal.root)).filter((entry) =>
        entry.includes(operationId),
      ),
    ).toEqual([]);
  });
});
