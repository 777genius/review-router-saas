import { createHash } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerCertifiedForkReviewOperatorRoutes } from "./certified-fork-review-operator-routes.js";

const credential = "operator-secret";
const body = {
  scope: {
    baseRepositoryId: "99",
    pullRequestNumber: 42,
    reviewHeadSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    contextHash: "c".repeat(64),
    promptPolicyVersion: 1,
  },
  reservationOwner: "d".repeat(64),
  expectedLeaseKey: `codex-rotating:99:500:1:fork:${"e".repeat(64)}`,
  incidentId: "INC-42",
  attestation: "provider_effect_absence_verified",
} as const;

describe("certified fork recovery operator route", () => {
  it("requires operator authority and forwards structured evidence", async () => {
    const recover = vi.fn(async () => undefined);
    const app = Fastify();
    await registerCertifiedForkReviewOperatorRoutes(app, {
      claims: { recoverAmbiguousPrelease: recover } as never,
      operatorCredentialSha256: createHash("sha256")
        .update(credential)
        .digest("hex"),
    });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/operator/v1/certified-fork-review/recover-ambiguous-prelease",
        payload: body,
      }),
    ).resolves.toMatchObject({ statusCode: 401 });
    const response = await app.inject({
      method: "POST",
      url: "/api/operator/v1/certified-fork-review/recover-ambiguous-prelease",
      headers: { authorization: `Bearer ${credential}` },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(recover).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedLeaseKey: body.expectedLeaseKey,
        operatorAuthority: {
          principal: "reviewrouter-operator",
          incidentId: "INC-42",
          attestation: "provider_effect_absence_verified",
        },
      }),
    );
  });
});
