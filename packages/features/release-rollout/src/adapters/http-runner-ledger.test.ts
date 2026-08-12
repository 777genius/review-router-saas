import { describe, expect, it, vi } from "vitest";
import { AuthenticatedRunnerLedgerAdapter } from "./http-runner-ledger";

const request = {
  rolloutId: "rollout-1",
  expectedCommitSha: "c".repeat(40),
  runId: "run-1",
  jobId: "job-1",
  runAttempt: 1,
  sourceSystemIdentifier: "100",
  targetSystemIdentifier: "200",
  previousReceiptSha256: `sha256:${"b".repeat(64)}`,
  targetDeployIds: ["deploy-1"],
  postgresMajor: 17 as const,
  migrationChecksum: "sha256:" + "7".repeat(64),
};

const authorization = {
  rolloutId: request.rolloutId,
  expectedCommitSha: request.expectedCommitSha,
  postgresMajor: request.postgresMajor,
  migrationChecksum: request.migrationChecksum,
  epoch: 2,
  nonce: "a".repeat(32),
  sourceSystemIdentifier: request.sourceSystemIdentifier,
  targetSystemIdentifier: request.targetSystemIdentifier,
  previousReceiptSha256: request.previousReceiptSha256,
  targetDeployIds: request.targetDeployIds,
  authorizedAt: "2026-08-12T00:00:00.000Z",
};

describe("authenticated runner ledger activation authorization", () => {
  it("fails closed on install timeout and retries the exact same request", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 504 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorization }), { status: 200 }),
      );
    const adapter = new AuthenticatedRunnerLedgerAdapter(
      "https://control.example.test",
      "control-token",
      fetchImpl,
    );

    await expect(adapter.authorizeActivation(request)).rejects.toThrow(
      "runner_ledger_request_failed:504",
    );
    await expect(adapter.authorizeActivation(request)).resolves.toEqual(
      authorization,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://control.example.test/v1/rollouts/rollout-1/activation-authorization",
    );
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(fetchImpl.mock.calls[0]?.[0]);
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(
      fetchImpl.mock.calls[0]?.[1]?.body,
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual(
      request,
    );
  });

  it("denies a conflicting authorization response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          authorization: { ...authorization, nonce: "d".repeat(32), epoch: 3 },
        }),
        { status: 409 },
      ),
    );
    const adapter = new AuthenticatedRunnerLedgerAdapter(
      "https://control.example.test",
      "control-token",
      fetchImpl,
    );

    await expect(adapter.authorizeActivation(request)).rejects.toThrow(
      "runner_ledger_request_failed:409",
    );
  });
});

describe("authenticated runner ledger reconciliation", () => {
  it.each([
    ["activated", "activated_forward_only"],
    ["forward_repair_required", "activation_uncertain_forward_only"],
  ] as const)(
    "maps the %s control response to %s",
    async (wireState, state) => {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            state: wireState,
            sourceEligible: false,
            sourceAclRestored: false,
            sourceServicesResumed: false,
            openRunnerJobs: 0,
          }),
          { status: 200 },
        ),
      );
      const adapter = new AuthenticatedRunnerLedgerAdapter(
        "https://control.example.test",
        "control-token",
        fetchImpl,
      );

      await expect(
        adapter.reconcileRollout("rollout-1"),
      ).resolves.toMatchObject({
        state,
        openRunnerJobs: 0,
      });
    },
  );
});
