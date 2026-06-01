import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { JoseGitLabCiIdTokenVerifier } from "./jose-gitlab-ci-id-token-verifier";

const issuer = "https://gitlab.example.com";
const audience = "reviewrouter";

describe("JoseGitLabCiIdTokenVerifier", () => {
  it("verifies GitLab CI ID tokens with configured issuer and audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    const token = await new SignJWT({
      sub: "project_path:group/project:ref_type:branch:ref:feature",
      namespace_id: 12,
      namespace_path: "group",
      project_id: 123,
      project_path: "group/project",
      job_project_id: 123,
      job_project_path: "group/project",
      user_id: 7,
      user_login: "ilya",
      pipeline_id: 1001,
      pipeline_source: "merge_request_event",
      job_id: 2002,
      ref: "feature",
      ref_type: "branch",
      sha: "a".repeat(40),
      ci_config_ref_uri: null,
      ci_config_sha: null,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5 minutes")
      .sign(privateKey);

    const verifier = new JoseGitLabCiIdTokenVerifier({
      issuer,
      jwks: createLocalJWKSet({ keys: [jwk] }),
    });

    await expect(verifier.verify({ token, audience })).resolves.toMatchObject({
      iss: issuer,
      aud: audience,
      project_id: "123",
      job_project_id: "123",
      project_path: "group/project",
      pipeline_source: "merge_request_event",
    });
  });
});
