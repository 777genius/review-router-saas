import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from "jose";
import { z } from "zod";

export const githubOidcIssuer = "https://token.actions.githubusercontent.com";
export const githubOidcJwks = createRemoteJWKSet(
  new URL(`${githubOidcIssuer}/.well-known/jwks`),
);

export const oidcClaimsSchema = z.object({
  iss: z.literal(githubOidcIssuer),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number().int(),
  nbf: z.number().int().optional(),
  iat: z.number().int(),
  repository: z.string().min(1),
  repository_id: z.string().min(1),
  repository_owner: z.string().min(1),
  repository_owner_id: z.string().min(1),
  event_name: z.string().min(1),
  run_id: z.string().min(1),
  run_attempt: z.string().min(1),
  workflow: z.string().min(1).optional(),
  workflow_ref: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  base_ref: z.string().optional(),
  head_ref: z.string().optional(),
  repository_visibility: z.string().optional(),
  actor: z.string().optional(),
  actor_id: z.string().optional(),
});

export type GitHubOidcClaims = z.infer<typeof oidcClaimsSchema>;

export function audienceMatches(
  aud: string | string[],
  expected: string,
): boolean {
  return Array.isArray(aud) ? aud.includes(expected) : aud === expected;
}

export function validateOidcClaims(
  payload: JWTPayload,
  expectedAudience: string,
  allowedRepositoryId?: string,
): GitHubOidcClaims {
  const claims = oidcClaimsSchema.parse(payload);
  if (!audienceMatches(claims.aud, expectedAudience)) {
    throw new Error("OIDC audience mismatch");
  }
  if (allowedRepositoryId && claims.repository_id !== allowedRepositoryId) {
    throw new Error("OIDC repository_id is not allowed");
  }
  return claims;
}

export async function verifyGitHubOidcToken(
  token: string,
  expectedAudience: string,
  allowedRepositoryId?: string,
): Promise<GitHubOidcClaims> {
  const result = await jwtVerify(token, githubOidcJwks, {
    issuer: githubOidcIssuer,
    audience: expectedAudience,
    clockTolerance: 60,
  });
  return validateOidcClaims(
    result.payload,
    expectedAudience,
    allowedRepositoryId,
  );
}

export async function createActionSessionToken(
  claims: GitHubOidcClaims,
  secret: string,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({
    repository: claims.repository,
    repository_id: claims.repository_id,
    run_id: claims.run_id,
    run_attempt: claims.run_attempt,
    event_name: claims.event_name,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("reviewrouter-action-api")
    .setIssuer("reviewrouter-spike")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(key);
}

export async function verifyActionSessionToken(
  token: string,
  secret: string,
): Promise<JWTPayload> {
  const key = new TextEncoder().encode(secret);
  const result = await jwtVerify(token, key, {
    issuer: "reviewrouter-spike",
    audience: "reviewrouter-action-api",
    clockTolerance: 15,
  });
  return result.payload;
}
