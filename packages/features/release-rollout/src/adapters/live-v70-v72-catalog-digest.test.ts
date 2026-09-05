import { describe, expect, it } from "vitest";

import { fencedLiveV70V72CatalogDigestSql } from "./live-v70-v72-catalog-digest.mjs";

const requiredCapture = (
  match: RegExpMatchArray | null,
  index: number,
  label: string,
) => {
  const capture = match?.[index];
  if (capture === undefined) {
    throw new Error(`Missing ${label} capture`);
  }
  return capture;
};

const quotedValues = (source: string) =>
  [...source.matchAll(/'([^']+)'/gu)].map((match) =>
    requiredCapture(match, 1, "quoted value"),
  );

const providerUpdateColumns = (source: string) => {
  const providerColumnCase = source.match(
    /AND r\.relname='CodexOAuthProviderInstance'\s+AND a\.attname IN \(([^)]+)\)\s+THEN(?:(?!\n\s+(?:WHEN|ELSE) )[\s\S])*?regexp_replace\(\s+split_part\(split_part\(v::text,'\/',1\),'=',2\),'\[w\]','','g'\s+\)/u,
  );
  return quotedValues(
    requiredCapture(providerColumnCase, 1, "provider column list"),
  );
};

describe("live V70-V72 catalog phase ACL normalization", () => {
  it("projects exactly the 60 reviewed Codex OAuth phase ACL tuples", () => {
    const relationCases = [
      ...fencedLiveV70V72CatalogDigestSql.matchAll(
        /AND relname IN \(([^)]+)\)\s+THEN '(\[a(?:w)?\])'/gu,
      ),
    ];
    const codexOAuthCases = [
      ...new Map(
        relationCases
          .map((match) => ({
            privileges: requiredCapture(match, 2, "relation privileges"),
            relations: quotedValues(requiredCapture(match, 1, "relation list")),
          }))
          .filter(({ relations }) =>
            relations.every((relation) => relation.startsWith("CodexOAuth")),
          )
          .map((aclCase) => [JSON.stringify(aclCase), aclCase]),
      ).values(),
    ];

    expect(codexOAuthCases).toEqual([
      {
        privileges: "[aw]",
        relations: [
          "CodexOAuthSecretNamespace",
          "CodexOAuthSetupDispatchAttempt",
          "CodexOAuthSetupPayloadClaim",
        ],
      },
      {
        privileges: "[a]",
        relations: [
          "CodexOAuthProviderInstance",
          "CodexOAuthSecretNamespace",
          "CodexOAuthSetupDispatchAttempt",
          "CodexOAuthSetupPayloadClaim",
        ],
      },
    ]);

    const providerColumns = providerUpdateColumns(
      fencedLiveV70V72CatalogDigestSql,
    );
    expect(providerColumns).toEqual([
      "activeAccountIdentityHash",
      "activeLeaseExpiresAt",
      "activeLeaseId",
      "activeSecretNamespaceEpoch",
      "activeSecretNamespaceId",
      "activeSecretNamespaceName",
      "latestGeneration",
      "latestGenerationHash",
      "mutationEpoch",
      "mutationOwner",
      "mutationOwnerId",
      "updatedAt",
      "state",
    ]);
    const mutatedProviderPattern = fencedLiveV70V72CatalogDigestSql.replace(
      "split_part(split_part(v::text,'/',1),'=',2),'[w]','','g'",
      "split_part(split_part(v::text,'/',1),'=',2),'[aw]','','g'",
    );
    expect(mutatedProviderPattern).not.toBe(fencedLiveV70V72CatalogDigestSql);
    expect(() => providerUpdateColumns(mutatedProviderPattern)).toThrow(
      "Missing provider column list capture",
    );
    const relationTupleCount = codexOAuthCases.reduce(
      (count, aclCase) => count + aclCase.relations.length,
      0,
    );
    expect(3 * (relationTupleCount + providerColumns.length)).toBe(60);
  });

  it("keeps DELETE, grant options, and unrelated ACL surfaces visible", () => {
    const deleteCase = fencedLiveV70V72CatalogDigestSql.match(
      /AND relname IN \(([^)]+)\)\s+THEN '\[awd\]'/u,
    );
    expect(quotedValues(deleteCase?.[1] ?? "")).toEqual([
      "GitHubInstallation",
      "HostedCodexCommentRefreshCapability",
      "HostedCodexCommentRefreshUse",
      "HostedCodexInvocationGrant",
      "HostedCodexPool",
      "HostedCodexRepositoryBinding",
    ]);
    expect("arw*d".replace(/[aw]/gu, "")).toBe("r*d");
    expect(fencedLiveV70V72CatalogDigestSql).toContain(
      "'schemas',coalesce((SELECT jsonb_agg(jsonb_build_object(",
    );
    expect(fencedLiveV70V72CatalogDigestSql).toContain(
      "FROM unnest(n.nspacl) v),'[]'::jsonb)",
    );
    expect(fencedLiveV70V72CatalogDigestSql).toContain(
      "FROM unnest(p.proacl) v),'[]'::jsonb)",
    );
    expect(fencedLiveV70V72CatalogDigestSql).toContain(
      "FROM unnest(d.defaclacl) v))",
    );
  });
});
