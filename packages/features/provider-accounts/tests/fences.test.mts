import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileWorkspaceBindingFences } from "../src/application/use-cases/reconcile-workspace-binding-fences";
import type {
  BindingFenceResponse,
  WorkspaceBindingFenceDeliveryPort,
  WorkspaceBindingFenceRepositoryPort,
} from "../src/application/ports/workspace-binding-fence-port";
import {
  ProviderAccountError,
  snapshotBindingFence,
  type WorkspaceAccountBinding,
  type ScopedBindingFence,
} from "../src/domain/provider-account";

const intent: ScopedBindingFence = {
  bindingId: "binding-x",
  workspaceId: "workspace-x",
  operationId: "op-x-2",
  policySubject: "binding-x",
  policyRevision: 2,
};
const applied: BindingFenceResponse = {
  state: "applied",
  operationId: "op-x-2",
  policySubject: "binding-x",
  policyRevision: 2,
};
const binding: WorkspaceAccountBinding = {
  id: "binding-x",
  workspaceId: "workspace-x",
  connectionId: "connection-x",
  state: "revoked",
  revision: 9,
  policyRevision: 2,
  pendingFence: {
    operationId: "op-x-2",
    policySubject: "binding-x",
    policyRevision: 2,
  },
  fenceAck: null,
};
const invalid = (error: unknown) =>
  error instanceof ProviderAccountError && error.code === "invalid_input";

// Honest application-boundary double: no simulated SQL, HTTP or gateway kernel.
function boundary(
  submit: BindingFenceResponse | Error,
  readback: BindingFenceResponse | Error,
  ack = true,
) {
  const calls: { action: string; intent: ScopedBindingFence }[] = [];
  const accounts: WorkspaceBindingFenceRepositoryPort = {
    async listPendingBindingFences() {
      return [binding];
    },
    async acknowledgeBindingFence(input) {
      calls.push({ action: "ack", intent: input });
      return ack;
    },
  };
  const delivery: WorkspaceBindingFenceDeliveryPort = {
    async submitFence(input) {
      calls.push({ action: "submit", intent: input });
      if (submit instanceof Error) throw submit;
      return submit;
    },
    async readFenceOperation(input) {
      calls.push({ action: "read", intent: input });
      if (readback instanceof Error) throw readback;
      return readback;
    },
  };
  return { accounts, delivery, calls };
}

// Regression: a success-shaped response for another subject/operation clears a fence.
test("wrong scope, operation, revision and malformed ACKs stay pending", async () => {
  for (const response of [
    { ...applied, operationId: "op-y-2" },
    { ...applied, policySubject: "binding-y" },
    { ...applied, policyRevision: 1 },
    { ...applied, policyRevision: 3 },
    { ...applied, policyRevision: -1 },
    { ...applied, policyRevision: 2147483648 },
  ]) {
    const f = boundary(response, response);
    const result = await reconcileWorkspaceBindingFences({ limit: 1 }, f);
    assert.deepEqual(result.results, [
      {
        bindingId: "binding-x",
        requiredPolicyRevision: 2,
        remoteFenceDelivery: "remote_pending",
      },
    ]);
    assert.deepEqual(
      f.calls.map((c) => c.action),
      ["submit", "read"],
    );
  }
});

for (const state of ["pending", "unknown", "rejected", "not_found"] as const) {
  // Regression: pending/unknown/rejected/404 is recorded as a durable remote ACK.
  test(`${state} is never durable ACK`, async () => {
    const f = boundary({ state }, { state });
    const result = await reconcileWorkspaceBindingFences({ limit: 1 }, f);
    assert.equal(result.results[0]?.remoteFenceDelivery, "remote_pending");
    assert.deepEqual(
      f.calls.map((c) => c.action),
      ["submit", "read"],
    );
  });
}

// Regression: a lost submit response changes operation IDs or claims success without readback.
test("lost ACK readback uses the same operation; durable receipt alone permits bookkeeping", async () => {
  const f = boundary(new Error("synthetic transport loss"), applied);
  assert.deepEqual(await reconcileWorkspaceBindingFences({ limit: 1 }, f), {
    results: [
      {
        bindingId: "binding-x",
        requiredPolicyRevision: 2,
        remoteFenceDelivery: "remote_applied",
      },
    ],
    nextAfterBindingId: "binding-x",
  });
  assert.deepEqual(f.calls, [
    { action: "submit", intent },
    { action: "read", intent },
    { action: "ack", intent },
  ]);
  const direct = boundary(applied, new Error("read must not be called"));
  await reconcileWorkspaceBindingFences({ limit: 1 }, direct);
  assert.deepEqual(
    direct.calls.map((c) => c.action),
    ["submit", "ack"],
  );
});

// Regression: stale CAS or an exception becomes a successful delivery report.
test("stale ACK CAS and delivery/storage exceptions preserve remote pending", async () => {
  for (const f of [
    boundary(applied, applied, false),
    boundary(new Error("submit"), new Error("read")),
  ]) {
    assert.equal(
      (await reconcileWorkspaceBindingFences({ limit: 1 }, f)).results[0]
        ?.remoteFenceDelivery,
      "remote_pending",
    );
  }
  const f = boundary(applied, applied);
  f.accounts.acknowledgeBindingFence = async () => {
    throw new Error("storage unavailable");
  };
  assert.equal(
    (await reconcileWorkspaceBindingFences({ limit: 1 }, f)).results[0]
      ?.remoteFenceDelivery,
    "remote_pending",
  );
});

// Regression: unbounded or caller-mutated page parameters/rows cross an await.
test("bounded page captures request and every intent before delivery waits", async () => {
  const f = boundary({ state: "pending" }, { state: "unknown" });
  const rows = [
    { ...binding, pendingFence: { ...binding.pendingFence! } },
    {
      ...binding,
      id: "binding-y",
      pendingFence: {
        operationId: "op-y-4",
        policySubject: "binding-y",
        policyRevision: 4,
      },
    },
  ];
  const request = { limit: 2, afterBindingId: "binding-a" };
  let readInput: unknown;
  f.accounts.listPendingBindingFences = async (input) => {
    readInput = { ...input };
    request.limit = 100;
    request.afterBindingId = "changed";
    return rows;
  };
  f.delivery.submitFence = async (input) => {
    f.calls.push({ action: "submit", intent: input });
    rows[1]!.pendingFence.policySubject = "changed";
    rows[1]!.pendingFence.operationId = "changed";
    return { state: "pending" };
  };
  const result = await reconcileWorkspaceBindingFences(request, f);
  assert.deepEqual(readInput, { limit: 2, afterBindingId: "binding-a" });
  assert.equal(result.nextAfterBindingId, "binding-y");
  assert.deepEqual(f.calls[2], {
    action: "submit",
    intent: {
      bindingId: "binding-y",
      workspaceId: "workspace-x",
      operationId: "op-y-4",
      policySubject: "binding-y",
      policyRevision: 4,
    },
  });
  for (const limit of [0, -1, 101, 1.5, NaN])
    await assert.rejects(
      reconcileWorkspaceBindingFences({ limit }, f),
      invalid,
    );
});

// Regression: malformed/wrong-subject persistence ACK input is accepted.
test("ACK input scope and inclusive persisted revision range are enforced", () => {
  for (const change of [
    { policySubject: "binding-y" },
    { operationId: "bad / ref" },
    { workspaceId: "" },
    { policyRevision: -1 },
    { policyRevision: 0 },
    { policyRevision: 1.5 },
    { policyRevision: 2147483648 },
  ])
    assert.throws(
      () => snapshotBindingFence({ ...intent, ...change }),
      invalid,
    );
  assert.equal(
    snapshotBindingFence({ ...intent, policyRevision: 2147483647 })
      .policyRevision,
    2147483647,
  );
});

// Regression: spreading pending metadata lets extra fields override the persisted
// row's workspace/binding scope, even though those fields are not part of the port.
test("pending metadata extra scope fields cannot redirect the persisted row", async () => {
  const f = boundary(applied, applied);
  f.accounts.listPendingBindingFences = async () => [
    {
      ...binding,
      pendingFence: Object.assign(
        {
          operationId: "op-x-2",
          policySubject: "binding-x",
          policyRevision: 2,
        },
        {
          bindingId: "binding-y",
          workspaceId: "workspace-y",
        },
      ),
    },
  ];
  const result = await reconcileWorkspaceBindingFences({ limit: 1 }, f);
  assert.equal(result.results[0]?.remoteFenceDelivery, "remote_applied");
  assert.deepEqual(f.calls, [
    { action: "submit", intent },
    { action: "ack", intent },
  ]);
});

// Regression: a wrong-subject intent bypasses scope validation by also injecting
// a matching bindingId/workspaceId into metadata; the row itself still belongs to X.
test("pending metadata cannot manufacture a matching scope for the wrong subject", async () => {
  const receipt: BindingFenceResponse = {
    state: "applied",
    operationId: "op-y-2",
    policySubject: "binding-y",
    policyRevision: 2,
  };
  const f = boundary(receipt, receipt);
  f.accounts.listPendingBindingFences = async () => [
    {
      ...binding,
      pendingFence: Object.assign(
        {
          operationId: "op-y-2",
          policySubject: "binding-y",
          policyRevision: 2,
        },
        {
          bindingId: "binding-y",
          workspaceId: "workspace-y",
        },
      ),
    },
  ];
  await assert.rejects(
    reconcileWorkspaceBindingFences({ limit: 1 }, f),
    invalid,
  );
  assert.deepEqual(f.calls, []);
});
