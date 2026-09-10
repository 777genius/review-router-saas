import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
