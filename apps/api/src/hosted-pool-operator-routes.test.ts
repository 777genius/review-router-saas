import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerHostedPoolOperatorRoutes } from "./hosted-pool-operator-routes";
import { createHostedPoolOperatorAuthorization } from "./hosted-pool-operator-authorization";
import { createHash } from "node:crypto";

const scope = {
  operatorId: "operator",
  workspaceId: "workspace",
  ownerGitHubUserId: "123",
};
const credential = "temporary-fake-credential-for-tests";
async function fixture() {
  let member = true;
  const authorize = createHostedPoolOperatorAuthorization({
    scope,
    credentialSha256: createHash("sha256").update(credential).digest("hex"),
    membership: {
      isCurrentAdmin: async (_scope, workspace) =>
        member && workspace === scope.workspaceId,
    },
  });
  const execute = vi.fn(async (scope, command, auth?: Uint8Array) => {
    void scope;
    void command;
    void auth;
    return { status: "imported" };
  });
  const status = vi.fn(async () => ({ pool: null }));
  const app = Fastify({ logger: false });
  await registerHostedPoolOperatorRoutes(app, {
    authorize,
    assertEntitled: async () => {},
    status,
    execute,
  });
  return {
    app,
    execute,
    status,
    revoke: () => {
      member = false;
    },
  };
}
describe("hosted pool HTTP boundary", () => {
  it("rejects credential and cross-tenant requests before reads or mutations", async () => {
    const f = await fixture();
    try {
      expect(
        (
          await f.app.inject({
            url: "/api/operator/v1/hosted-pool?workspace=workspace",
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await f.app.inject({
            url: "/api/operator/v1/hosted-pool?workspace=foreign",
            headers: { authorization: `Bearer ${credential}` },
          })
        ).statusCode,
      ).toBe(403);
      expect(f.status).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
  it("checks revoked membership on each request", async () => {
    const f = await fixture();
    try {
      const request = {
        url: "/api/operator/v1/hosted-pool?workspace=workspace",
        headers: { authorization: `Bearer ${credential}` },
      };
      expect((await f.app.inject(request)).statusCode).toBe(200);
      f.revoke();
      expect((await f.app.inject(request)).statusCode).toBe(403);
      expect(f.status).toHaveBeenCalledTimes(1);
    } finally {
      await f.app.close();
    }
  });
  it("does not accept server file paths or noncanonical/oversized auth", async () => {
    const f = await fixture();
    try {
      for (const payload of [
        {
          workspace: "workspace",
          label: "primary",
          authFile: "/arbitrary/server/path",
        },
        { workspace: "workspace", label: "primary", authBase64: "not base64" },
        {
          workspace: "workspace",
          label: "primary",
          authBase64: Buffer.alloc(1024 * 1024 + 1).toString("base64"),
        },
      ])
        expect(
          (
            await f.app.inject({
              method: "POST",
              url: "/api/operator/v1/hosted-pool/accounts/import",
              headers: { authorization: `Bearer ${credential}` },
              payload,
            })
          ).statusCode,
        ).toBe(400);
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
  it("redacts arbitrary adapter errors and clears decoded bytes on failure", async () => {
    const f = await fixture();
    let observed: Uint8Array | undefined;
    f.execute.mockImplementation(async (_scope, _command, bytes) => {
      observed = bytes;
      throw new Error("temporary-fake-provider-secret");
    });
    try {
      const response = await f.app.inject({
        method: "POST",
        url: "/api/operator/v1/hosted-pool/accounts/import",
        headers: { authorization: `Bearer ${credential}` },
        payload: {
          workspace: "workspace",
          label: "primary",
          authBase64: Buffer.from("temporary-fake-provider-secret").toString(
            "base64",
          ),
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.body).not.toContain("temporary-fake-provider-secret");
      expect(observed?.every((byte) => byte === 0)).toBe(true);
    } finally {
      await f.app.close();
    }
  });
});
