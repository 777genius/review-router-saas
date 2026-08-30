import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CertifiedForkReviewClaimPort } from "@reviewrouter/features-action-control-plane";

const bodySchema = z.strictObject({
  scope: z.strictObject({
    baseRepositoryId: z.string().regex(/^[1-9][0-9]*$/u),
    pullRequestNumber: z.number().int().positive(),
    reviewHeadSha: z.string().regex(/^[a-f0-9]{40}$/u),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/u),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/u),
    promptPolicyVersion: z.number().int().positive(),
  }),
  reservationOwner: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedLeaseKey: z.string().min(40).max(500),
  incidentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/u),
  attestation: z.literal("provider_effect_absence_verified"),
});

export async function registerCertifiedForkReviewOperatorRoutes(
  app: FastifyInstance,
  input: {
    claims: CertifiedForkReviewClaimPort;
    operatorCredentialSha256: string;
  },
): Promise<void> {
  app.post(
    "/api/operator/v1/certified-fork-review/recover-ambiguous-prelease",
    { bodyLimit: 4_096 },
    async (request, reply) => {
      const credential =
        request.headers.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? "";
      if (!credentialMatches(credential, input.operatorCredentialSha256))
        return reply.code(401).send({ error: "operator_unauthorized" });
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_request" });
      try {
        await input.claims.recoverAmbiguousPrelease({
          scope: parsed.data.scope,
          reservationOwner: parsed.data.reservationOwner,
          expectedLeaseKey: parsed.data.expectedLeaseKey,
          operatorAuthority: {
            principal: "reviewrouter-operator",
            incidentId: parsed.data.incidentId,
            attestation: parsed.data.attestation,
          },
        });
        return reply
          .header("Cache-Control", "no-store")
          .send({ status: "recovered" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("recovery_uncertain"))
          return reply.code(412).send({ error: "provider_effect_uncertain" });
        if (message.includes("recovery_conflict"))
          return reply.code(409).send({ error: "recovery_conflict" });
        throw error;
      }
    },
  );
}

function credentialMatches(
  credential: string,
  expectedSha256: string,
): boolean {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) return false;
  const actual = Buffer.from(
    createHash("sha256").update(credential).digest("hex"),
  );
  const expected = Buffer.from(expectedSha256);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
