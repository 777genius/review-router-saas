import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executePoolCli, readPoolAuthFile } from "./reviewrouter-pool-cli";
import { executeReviewRouterOperatorCli } from "./reviewrouter-operator-cli";

describe("pool operator CLI", () => {
  it("uses existing profile credential and redirect-error transport", async () => {
    const credential = randomBytes(24).toString("base64url");
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init.redirect).toBe("error");
      expect(init.headers.authorization).toBe(`Bearer ${credential}`);
      return new Response(JSON.stringify({ result: { pool: null } }), {
        status: 200,
      });
    });
    expect(
      await executeReviewRouterOperatorCli(
        ["pool", "status", "--workspace", "my-workspace"],
        {
          REVIEW_ROUTER_API_URL: "https://operator.invalid",
          REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL: credential,
        },
        { fetchImpl: fetchImpl as typeof fetch },
      ),
    ).toEqual({ pool: null });
  });
  it("preserves partial bulk results and proceeds sequentially after failure", async () => {
    const events: string[] = [];
    const request = vi.fn(async (method, _path, body) => {
      if (method === "GET")
        return {
          repositories: ["a", "b", "c"].map((name) => ({
            fullName: `owner/${name}`,
            eligible: true,
            bindingRevision: 7,
          })),
        };
      events.push(body.repository);
      if (body.repository === "owner/b")
        throw new Error("fake-secret-never-reflect");
      return { status: "already_active" };
    });
    const result = await executePoolCli({
      command: "pool repositories connect",
      options: { workspace: "a", all: true },
      request,
    });
    expect(events).toEqual(["owner/a", "owner/b", "owner/c"]);
    expect(result).toMatchObject({ status: "partial_failure" });
    expect(JSON.stringify(result)).not.toContain("fake-secret");
  });
  it("distinguishes binding conflicts from partial bulk failures", async () => {
    const result = await executePoolCli({
      command: "pool repositories connect",
      options: { workspace: "a", all: true },
      request: async (method) => {
        if (method === "GET")
          return {
            repositories: [
              { fullName: "owner/a", eligible: true, bindingRevision: 1 },
            ],
          };
        throw new Error("hosted_pool_conflict");
      },
    });
    expect(result).toMatchObject({
      status: "partial_failure",
      results: [
        {
          repository: "owner/a",
          status: "conflict",
          code: "hosted_pool_conflict",
        },
      ],
    });
  });
  it("rereads after uncertain import without retry and wipes the source buffer", async () => {
    const bytes = Buffer.from("temporary-fake-auth");
    const request = vi.fn(async (method) => {
      if (method === "POST") throw new Error("temporary-fake-auth");
      return { accounts: [{ id: "account", generation: 4 }] };
    });
    const result = await executePoolCli({
      command: "pool accounts import",
      options: { workspace: "a", label: "primary", "auth-file": "fake" },
      request,
      readAuthFile: async () => bytes,
    });
    expect(result).toMatchObject({ status: "reconcile_required" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("temporary-fake-auth");
  });
  it("bounds local reads and returns safe errors", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rr-pool-cli-"));
    try {
      const file = path.join(directory, "fake-auth.json");
      await writeFile(file, Buffer.alloc(1024 * 1024 + 1, 1));
      await expect(readPoolAuthFile(file)).rejects.toThrow(
        "hosted_pool_auth_file_invalid",
      );
      await writeFile(file, "fake-small-auth");
      expect((await readPoolAuthFile(file)).toString()).toBe("fake-small-auth");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("dry run never mutates", async () => {
    const request = vi.fn(async () => ({
      repositories: [
        { fullName: "owner/a", eligible: true, bindingRevision: null },
      ],
    }));
    await executePoolCli({
      command: "pool repositories connect",
      options: { workspace: "a", all: true, "dry-run": true },
      request,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("GET", expect.any(String));
  });
});
