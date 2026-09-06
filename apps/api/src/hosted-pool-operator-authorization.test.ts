import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createHostedPoolOperatorAuthorization,
  readHostedPoolOperatorScope,
} from "./hosted-pool-operator-authorization";

const scope = {
  operatorId: "operator",
  workspaceId: "workspace-a",
  ownerGitHubUserId: "123",
};
const credential = "temporary-fake-operator-credential";
const credentialSha256 = createHash("sha256").update(credential).digest("hex");
describe("hosted pool operator authority", () => {
  it("fails closed when unset or partially enabled", () => {
    expect(readHostedPoolOperatorScope({})).toBeNull();
    expect(() =>
      readHostedPoolOperatorScope({
        REVIEW_ROUTER_HOSTED_POOL_OPERATOR_ENABLED: "1",
      }),
    ).toThrow("scope_invalid");
  });
  it("authenticates before membership reads and rejects foreign workspace", async () => {
    const isCurrentAdmin = vi.fn(
      async (_scope, workspace) => workspace === scope.workspaceId,
    );
    const authorize = createHostedPoolOperatorAuthorization({
      scope,
      credentialSha256,
      membership: { isCurrentAdmin },
    });
    await expect(authorize("wrong", "workspace-a")).rejects.toThrow(
      "unauthorized",
    );
    expect(isCurrentAdmin).not.toHaveBeenCalled();
    await expect(authorize(credential, "workspace-b")).rejects.toThrow(
      "forbidden",
    );
    expect(await authorize(credential, "workspace-a")).toEqual(scope);
  });
  it("does not cache revoked membership", async () => {
    let member = true;
    const authorize = createHostedPoolOperatorAuthorization({
      scope,
      credentialSha256,
      membership: { isCurrentAdmin: async () => member },
    });
    await authorize(credential, "workspace-a");
    member = false;
    await expect(authorize(credential, "workspace-a")).rejects.toThrow(
      "forbidden",
    );
  });
});
