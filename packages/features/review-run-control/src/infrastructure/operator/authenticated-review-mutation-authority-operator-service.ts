import { timingSafeEqual } from "node:crypto";
import type { Sha256DigestPort } from "../../application/ports/platform-ports";
import type { ReviewMutationAuthorityProofReference } from "../../domain/review-mutation-authority-proof";
import {
  ReviewMutationAuthorityCommandKind,
  type ReviewMutationAuthorityOperatorUseCases,
} from "../../application/use-cases/manage-review-mutation-authority";
import {
  assertIdentifier,
  assertSha256,
  invalid,
} from "../../domain/review-run-control-types";

export enum ReviewMutationOperatorPermission {
  ControlMutationAuthority = "control_mutation_authority",
}

export type ReviewMutationOperatorPrincipal = Readonly<{
  operatorId: string;
  permissions: readonly ReviewMutationOperatorPermission[];
}>;

export interface ReviewMutationOperatorAuthenticationPort {
  authenticate(input: {
    readonly credential: string;
    readonly operation: ReviewMutationAuthorityCommandKind;
  }): Promise<ReviewMutationOperatorPrincipal | null>;
}

export enum ReviewMutationOperatorAccessErrorCode {
  Unauthorized = "unauthorized",
  Forbidden = "forbidden",
}

export class ReviewMutationOperatorAccessError extends Error {
  constructor(readonly code: ReviewMutationOperatorAccessErrorCode) {
    super("review_mutation_operator_access_denied");
    this.name = "ReviewMutationOperatorAccessError";
  }
}

type AuthenticatedOperatorCommand = {
  readonly credential: string;
  readonly scmRepositoryIdentityId: string;
};

export class AuthenticatedReviewMutationAuthorityOperatorService {
  constructor(
    private readonly dependencies: {
      readonly authentication: ReviewMutationOperatorAuthenticationPort;
      readonly useCases: ReviewMutationAuthorityOperatorUseCases;
    },
  ) {}

  async preflight(
    input: AuthenticatedOperatorCommand & {
      readonly operation: ReviewMutationAuthorityCommandKind;
    },
  ) {
    await this.authorize(input.credential, input.operation);
    return this.dependencies.useCases.preflight({
      scmRepositoryIdentityId: input.scmRepositoryIdentityId,
      operation: input.operation,
    });
  }

  async beginDrain(
    input: AuthenticatedOperatorCommand & {
      readonly expectedVersion: number;
      readonly drainPolicyVersion: number;
      readonly drainWindowMs: number;
    },
  ) {
    await this.authorize(
      input.credential,
      ReviewMutationAuthorityCommandKind.BeginDrain,
    );
    return this.dependencies.useCases.beginDrain({
      scmRepositoryIdentityId: input.scmRepositoryIdentityId,
      expectedVersion: input.expectedVersion,
      drainPolicyVersion: input.drainPolicyVersion,
      drainWindowMs: input.drainWindowMs,
    });
  }

  async initializeDirectV2(
    input: AuthenticatedOperatorCommand & {
      readonly proof: ReviewMutationAuthorityProofReference;
    },
  ) {
    await this.authorize(
      input.credential,
      ReviewMutationAuthorityCommandKind.DirectV2Initialize,
    );
    return this.dependencies.useCases.initializeDirectV2({
      scmRepositoryIdentityId: input.scmRepositoryIdentityId,
      proof: input.proof,
    });
  }

  async abortDrain(
    input: AuthenticatedOperatorCommand & {
      readonly expectedVersion: number;
      readonly proof: ReviewMutationAuthorityProofReference;
    },
  ) {
    await this.authorize(
      input.credential,
      ReviewMutationAuthorityCommandKind.AbortDrain,
    );
    return this.dependencies.useCases.abortDrain({
      scmRepositoryIdentityId: input.scmRepositoryIdentityId,
      expectedVersion: input.expectedVersion,
      proof: input.proof,
    });
  }

  async activate(
    input: AuthenticatedOperatorCommand & {
      readonly expectedVersion: number;
      readonly proof: ReviewMutationAuthorityProofReference;
    },
  ) {
    await this.authorize(
      input.credential,
      ReviewMutationAuthorityCommandKind.Activate,
    );
    return this.dependencies.useCases.activate({
      scmRepositoryIdentityId: input.scmRepositoryIdentityId,
      expectedVersion: input.expectedVersion,
      proof: input.proof,
    });
  }

  async pause(
    input: AuthenticatedOperatorCommand & {
      readonly expectedVersion: number;
    },
  ) {
    await this.authorize(
      input.credential,
      ReviewMutationAuthorityCommandKind.Pause,
    );
    return this.dependencies.useCases.pause({
      scmRepositoryIdentityId: input.scmRepositoryIdentityId,
      expectedVersion: input.expectedVersion,
    });
  }

  async resume(
    input: AuthenticatedOperatorCommand & {
      readonly expectedVersion: number;
      readonly proof: ReviewMutationAuthorityProofReference;
    },
  ) {
    await this.authorize(
      input.credential,
      ReviewMutationAuthorityCommandKind.Resume,
    );
    return this.dependencies.useCases.resume({
      scmRepositoryIdentityId: input.scmRepositoryIdentityId,
      expectedVersion: input.expectedVersion,
      proof: input.proof,
    });
  }

  private async authorize(
    credential: string,
    operation: ReviewMutationAuthorityCommandKind,
  ): Promise<ReviewMutationOperatorPrincipal> {
    if (credential.length < 1 || credential.length > 8_192) {
      throw new ReviewMutationOperatorAccessError(
        ReviewMutationOperatorAccessErrorCode.Unauthorized,
      );
    }
    const principal = await this.dependencies.authentication.authenticate({
      credential,
      operation,
    });
    if (!principal) {
      throw new ReviewMutationOperatorAccessError(
        ReviewMutationOperatorAccessErrorCode.Unauthorized,
      );
    }
    if (
      !principal.permissions.includes(
        ReviewMutationOperatorPermission.ControlMutationAuthority,
      )
    ) {
      throw new ReviewMutationOperatorAccessError(
        ReviewMutationOperatorAccessErrorCode.Forbidden,
      );
    }
    return principal;
  }
}

export type HashedReviewMutationOperatorCredential = Readonly<{
  operatorId: string;
  credentialSha256: string;
  permissions: readonly ReviewMutationOperatorPermission[];
}>;

export class HashedReviewMutationOperatorAuthenticator implements ReviewMutationOperatorAuthenticationPort {
  private readonly credentials: readonly HashedReviewMutationOperatorCredential[];

  constructor(
    private readonly digest: Sha256DigestPort,
    credentials: readonly HashedReviewMutationOperatorCredential[],
  ) {
    const uniqueDigests = new Set<string>();
    this.credentials = Object.freeze(
      credentials.map((entry) => {
        assertIdentifier(entry.operatorId, "operator_id");
        assertSha256(entry.credentialSha256, "operator_credential_sha256");
        if (uniqueDigests.has(entry.credentialSha256)) {
          invalid("operator_credential_digest_duplicate");
        }
        uniqueDigests.add(entry.credentialSha256);
        return Object.freeze({
          operatorId: entry.operatorId,
          credentialSha256: entry.credentialSha256,
          permissions: Object.freeze([...entry.permissions]),
        });
      }),
    );
  }

  async authenticate(input: {
    readonly credential: string;
    readonly operation: ReviewMutationAuthorityCommandKind;
  }): Promise<ReviewMutationOperatorPrincipal | null> {
    void input.operation;
    if (this.credentials.length === 0 || input.credential.length === 0) {
      return null;
    }
    const candidateDigest = await this.digest.digestUtf8(input.credential);
    const match = this.credentials.find((entry) =>
      constantTimeEqual(entry.credentialSha256, candidateDigest),
    );
    return match
      ? Object.freeze({
          operatorId: match.operatorId,
          permissions: Object.freeze([...match.permissions]),
        })
      : null;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
