import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  createProducerRelease,
  canonicalReviewProtocolLimits,
  producerReleaseImmutableKey,
  ProducerReleaseState,
  type ProducerRelease,
  type ProducerReleaseQueryPort,
  type ReviewProtocolLimitsV2,
} from "@reviewrouter/features-review-run-control";
import { reviewActionV2AbsoluteProtocolMaxima } from "./review-action-v2-protocol-policy";

export const repositoryReleaseBindingsEnv =
  "REVIEW_ROUTER_REVIEW_V2_REPOSITORY_RELEASE_BINDINGS";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/);
const bindingSchema = z.strictObject({
  workspaceId: id,
  repositoryConnectionId: id,
  scmRepositoryIdentityId: id,
  actionCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
  expectedBaseProducerReleaseId: id,
  selectedProducerReleaseId: id,
  protocolLimitsProfileId: id,
  limitsDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RepositoryReleaseBinding = z.infer<typeof bindingSchema>;
export type RepositoryReleaseScope = Pick<
  RepositoryReleaseBinding,
  | "workspaceId"
  | "repositoryConnectionId"
  | "scmRepositoryIdentityId"
  | "actionCommitSha"
>;
export interface RepositoryReleaseSelector {
  select(
    input: RepositoryReleaseScope & { readonly baseRelease: ProducerRelease },
  ): Promise<ProducerRelease>;
}
export type RepositoryReleaseQueries = ProducerReleaseQueryPort & {
  findProtocolLimitsProfileById(
    id: string,
  ): Promise<ReviewProtocolLimitsV2 | null>;
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const scopeKey = (scope: RepositoryReleaseScope) =>
  canonicalJson({
    workspaceId: scope.workspaceId,
    repositoryConnectionId: scope.repositoryConnectionId,
    scmRepositoryIdentityId: scope.scmRepositoryIdentityId,
    actionCommitSha: scope.actionCommitSha,
  });
function fail(): never {
  throw new Error("review_v2_repository_release_selection_invalid");
}

/** Undefined is disabled; an explicitly supplied document must be valid. */
export function parseRepositoryReleaseBindings(
  raw: string | undefined,
): readonly Readonly<RepositoryReleaseBinding>[] {
  const bindings = z
    .array(bindingSchema)
    .max(1000)
    .parse(raw === undefined ? [] : JSON.parse(raw));
  const keys = new Set<string>();
  for (const binding of bindings) {
    const key = scopeKey(binding);
    if (
      keys.has(key) ||
      binding.selectedProducerReleaseId ===
        binding.expectedBaseProducerReleaseId
    )
      fail();
    keys.add(key);
    Object.freeze(binding);
  }
  return Object.freeze(bindings);
}

export function createRepositoryReleaseSelector(
  raw: string | undefined,
  queries: RepositoryReleaseQueries,
) {
  const bindings = parseRepositoryReleaseBindings(raw);
  const configurationDigest = hash(canonicalJson(bindings));
  const byScope = new Map(
    bindings.map((binding) => [scopeKey(binding), binding]),
  );
  return {
    configurationDigest,
    async select(
      input: RepositoryReleaseScope & { readonly baseRelease: ProducerRelease },
    ): Promise<ProducerRelease> {
      const binding = byScope.get(scopeKey(input));
      if (!binding) return input.baseRelease;
      if (
        binding.expectedBaseProducerReleaseId !==
          input.baseRelease.producerReleaseId ||
        input.baseRelease.actionCommitSha !== input.actionCommitSha
      )
        fail();
      const [base, selected, profile, baseProfile] = await Promise.all([
        queries.findProducerReleaseById(binding.expectedBaseProducerReleaseId),
        queries.findProducerReleaseById(binding.selectedProducerReleaseId),
        queries.findProtocolLimitsProfileById(binding.protocolLimitsProfileId),
        queries.findProtocolLimitsProfileById(
          input.baseRelease.protocolLimitsProfileId,
        ),
      ]);
      if (
        !base ||
        !selected ||
        !profile ||
        !baseProfile ||
        base.state !== ProducerReleaseState.Registered ||
        selected.state !== ProducerReleaseState.Registered ||
        base.producerReleaseId !== binding.expectedBaseProducerReleaseId ||
        selected.producerReleaseId !== binding.selectedProducerReleaseId ||
        profile.protocolLimitsProfileId !== binding.protocolLimitsProfileId ||
        baseProfile.protocolLimitsProfileId !== base.protocolLimitsProfileId ||
        base.protocolLimitsProfileId === profile.protocolLimitsProfileId ||
        selected.protocolLimitsProfileId !== profile.protocolLimitsProfileId ||
        producerReleaseImmutableKey(base) !==
          producerReleaseImmutableKey(input.baseRelease) ||
        producerReleaseImmutableKey({
          ...selected,
          protocolLimitsProfileId: base.protocolLimitsProfileId,
        }) !== producerReleaseImmutableKey(base)
      )
        fail();
      createProducerRelease(base, base.registeredAt);
      createProducerRelease(selected, selected.registeredAt);
      for (const candidate of [baseProfile, profile]) {
        for (const key of Object.keys(
          reviewActionV2AbsoluteProtocolMaxima,
        ) as (keyof typeof reviewActionV2AbsoluteProtocolMaxima)[]) {
          const value = candidate[key];
          if (
            !Number.isSafeInteger(value) ||
            value <= 0 ||
            value > reviewActionV2AbsoluteProtocolMaxima[key]
          )
            fail();
          if (
            key !== "maxLeaseDurationMs" &&
            key !== "maxResultReportDurationMs" &&
            profile[key] !== baseProfile[key]
          )
            fail();
        }
        if (
          candidate.maxResultReportDurationMs < candidate.maxLeaseDurationMs ||
          hash(canonicalReviewProtocolLimits(candidate)) !==
            candidate.limitsDigest
        )
          fail();
      }
      if (profile.limitsDigest !== binding.limitsDigest) fail();
      return selected;
    },
  } satisfies RepositoryReleaseSelector & { configurationDigest: string };
}
