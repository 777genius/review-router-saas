import { describe, expect, it, vi } from "vitest";
import {
  ReviewMutationAuthorityCommandKind,
  ReviewMutationAuthorityPreflightStatus,
  type ReviewMutationAuthorityOperatorUseCases,
} from "../application/use-cases/manage-review-mutation-authority";
import { NodeSha256Digest } from "../infrastructure/node-sha256-digest";
import {
  AuthenticatedReviewMutationAuthorityOperatorService,
  HashedReviewMutationOperatorAuthenticator,
  ReviewMutationOperatorAccessErrorCode,
  ReviewMutationOperatorPermission,
} from "../infrastructure/operator/authenticated-review-mutation-authority-operator-service";

describe("authenticated ReviewMutationAuthority operator adapter", () => {
  it("fails closed before invoking application use cases", async () => {
    const preflight = vi.fn<OperatorUseCases["preflight"]>();
    const service = new AuthenticatedReviewMutationAuthorityOperatorService({
      authentication: {
        authenticate: vi.fn().mockResolvedValue(null),
      },
      useCases: useCases({ preflight }),
    });

    await expect(
      service.preflight({
        credential: "wrong-secret",
        scmRepositoryIdentityId: "scm-1",
        operation: ReviewMutationAuthorityCommandKind.Activate,
      }),
    ).rejects.toMatchObject({
      code: ReviewMutationOperatorAccessErrorCode.Unauthorized,
    });
    expect(preflight).not.toHaveBeenCalled();
  });

  it("rejects authenticated principals without control permission", async () => {
    const beginDrain = vi.fn<OperatorUseCases["beginDrain"]>();
    const service = new AuthenticatedReviewMutationAuthorityOperatorService({
      authentication: {
        authenticate: vi.fn().mockResolvedValue({
          operatorId: "observer-1",
          permissions: [],
        }),
      },
      useCases: useCases({ beginDrain }),
    });

    await expect(
      service.beginDrain({
        credential: "observer-secret",
        scmRepositoryIdentityId: "scm-1",
        expectedVersion: 1,
        drainPolicyVersion: 1,
        drainWindowMs: 60_000,
      }),
    ).rejects.toMatchObject({
      code: ReviewMutationOperatorAccessErrorCode.Forbidden,
    });
    expect(beginDrain).not.toHaveBeenCalled();
  });

  it("authenticates a hashed credential and delegates only to the use case", async () => {
    const digest = new NodeSha256Digest();
    const credential = "operator-secret";
    const credentialSha256 = await digest.digestUtf8(credential);
    const preflight = vi.fn<OperatorUseCases["preflight"]>().mockResolvedValue({
      status: ReviewMutationAuthorityPreflightStatus.Missing,
      operation: ReviewMutationAuthorityCommandKind.Activate,
    });
    const service = new AuthenticatedReviewMutationAuthorityOperatorService({
      authentication: new HashedReviewMutationOperatorAuthenticator(digest, [
        {
          operatorId: "operator-1",
          credentialSha256,
          permissions: [
            ReviewMutationOperatorPermission.ControlMutationAuthority,
          ],
        },
      ]),
      useCases: useCases({ preflight }),
    });

    await expect(
      service.preflight({
        credential,
        scmRepositoryIdentityId: "scm-1",
        operation: ReviewMutationAuthorityCommandKind.Activate,
      }),
    ).resolves.toEqual({
      status: ReviewMutationAuthorityPreflightStatus.Missing,
      operation: ReviewMutationAuthorityCommandKind.Activate,
    });
    expect(preflight).toHaveBeenCalledWith({
      scmRepositoryIdentityId: "scm-1",
      operation: ReviewMutationAuthorityCommandKind.Activate,
    });
  });

  it("authenticates explicit v1 initialization before delegating", async () => {
    const initializeV1 = vi
      .fn<OperatorUseCases["initializeV1"]>()
      .mockResolvedValue({ status: "applied" } as never);
    const service = new AuthenticatedReviewMutationAuthorityOperatorService({
      authentication: {
        authenticate: vi.fn().mockResolvedValue({
          operatorId: "operator-1",
          permissions: [
            ReviewMutationOperatorPermission.ControlMutationAuthority,
          ],
        }),
      },
      useCases: useCases({ initializeV1 }),
    });

    await service.initializeV1({
      credential: "operator-secret",
      scmRepositoryIdentityId: "scm-1",
    });

    expect(initializeV1).toHaveBeenCalledWith({
      scmRepositoryIdentityId: "scm-1",
    });
  });
});

type OperatorUseCases = ReviewMutationAuthorityOperatorUseCases;

function useCases(overrides: Partial<OperatorUseCases> = {}): OperatorUseCases {
  return {
    preflight: overrides.preflight ?? vi.fn<OperatorUseCases["preflight"]>(),
    initializeV1:
      overrides.initializeV1 ?? vi.fn<OperatorUseCases["initializeV1"]>(),
    initializeDirectV2:
      overrides.initializeDirectV2 ??
      vi.fn<OperatorUseCases["initializeDirectV2"]>(),
    beginDrain: overrides.beginDrain ?? vi.fn<OperatorUseCases["beginDrain"]>(),
    abortDrain: overrides.abortDrain ?? vi.fn<OperatorUseCases["abortDrain"]>(),
    activate: overrides.activate ?? vi.fn<OperatorUseCases["activate"]>(),
    pause: overrides.pause ?? vi.fn<OperatorUseCases["pause"]>(),
    resume: overrides.resume ?? vi.fn<OperatorUseCases["resume"]>(),
  };
}
