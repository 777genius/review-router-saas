import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderAccountError,
  selectBinding,
  type WorkspaceAccountBinding,
  type ProviderAccountConnection,
} from "../src/domain/provider-account";

const binding: WorkspaceAccountBinding = {
  id: "binding-x",
  workspaceId: "workspace-x",
  connectionId: "connection-x",
  state: "revoked",
  revision: 9,
  policyRevision: 2,
  pendingFence: null,
  fenceAck: null,
};
const connection: ProviderAccountConnection = {
  id: "connection-x",
  owner: { kind: "workspace", workspaceId: "workspace-x" },
  gatewayAccountRef: "account-x",
  gatewayOperationRef: null,
  profileRef: "profile-x",
  displayName: "X",
  state: "active",
  metadataRevision: 1,
};
// Regression: selecting uses reconstructs policy from the binding CAS counter.
test("selection retains independent versions and the opaque binding subject", () => {
  assert.deepEqual(
    selectBinding("workspace-x", "binding-x", {
      binding: { ...binding, state: "active" },
      connection,
    }),
    {
      workspaceId: "workspace-x",
      bindingId: "binding-x",
      bindingRevision: 9,
      policySubject: "binding-x",
      policyRevision: 2,
      connectionId: "connection-x",
      gatewayAccountRef: "account-x",
      profileRef: "profile-x",
    },
  );
});

test("rebound selection waits for the retained fence; ACK alone cannot restore revoked state", () => {
  const rebound: WorkspaceAccountBinding = {
    ...binding,
    state: "active",
    revision: 3,
    policyRevision: 3,
    pendingFence: {
      operationId: "op-x-2",
      policySubject: "binding-x",
      policyRevision: 2,
    },
  };
  const unavailable = (e: unknown) =>
    e instanceof ProviderAccountError && e.code === "binding_unavailable";
  assert.throws(
    () =>
      selectBinding("workspace-x", "binding-x", {
        binding: rebound,
        connection,
      }),
    unavailable,
  );
  const acked: WorkspaceAccountBinding = {
    ...rebound,
    pendingFence: null,
    fenceAck: { operationId: "op-x-2", policyRevision: 2 },
  };
  assert.equal(
    selectBinding("workspace-x", "binding-x", {
      binding: acked,
      connection,
    }).policyRevision,
    3,
  );
  assert.throws(
    () =>
      selectBinding("workspace-x", "binding-x", {
        binding: { ...acked, state: "revoked" },
        connection,
      }),
    unavailable,
  );
});

// Regression: malformed storage tuples authorize negative, overflowing or missing versions.
test("both persisted versions are validated independently", () => {
  for (const field of ["revision", "policyRevision"] as const) {
    for (const value of [-1, 0, 1.5, NaN, 2147483648, undefined]) {
      assert.throws(
        () =>
          selectBinding("workspace-x", "binding-x", {
            binding: { ...binding, state: "active", [field]: value },
            connection,
          }),
        (e: unknown) =>
          e instanceof ProviderAccountError && e.code === "binding_unavailable",
      );
    }
  }
  assert.equal(
    selectBinding("workspace-x", "binding-x", {
      binding: {
        ...binding,
        state: "active",
        revision: 2147483647,
        policyRevision: 1,
      },
      connection,
    }).policyRevision,
    1,
  );
});
