import {
  createScmRepositoryIdentity,
  normalizeScmSourceBaseUrl,
  type ScmRepositoryIdentity,
} from "../../domain/scm-repository-identity";
import {
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ScmProvider,
} from "../../domain/review-run-control-types";
import type { ClockPort, IdentifierFactoryPort } from "../ports/platform-ports";
import type { ReviewMutationAuthorityQueryPort } from "../ports/review-mutation-authority-ports";
import type {
  ScmRepositoryIdentityCommandPort,
  ScmRepositoryIdentityQueryPort,
} from "../ports/scm-repository-identity-ports";
import { ScmRepositoryIdentityBindingStatus } from "../ports/scm-repository-identity-ports";

export type TrustedScmRepositoryFacts = {
  readonly provider: ScmProvider;
  readonly sourceBaseUrl: string;
  readonly externalRepositoryId: string;
};

export class ManageScmRepositoryIdentities {
  constructor(
    private readonly dependencies: {
      readonly clock: ClockPort;
      readonly identifiers: IdentifierFactoryPort;
      readonly identityQueries: ScmRepositoryIdentityQueryPort;
      readonly identityCommands: ScmRepositoryIdentityCommandPort;
      readonly authorityQueries: ReviewMutationAuthorityQueryPort;
    },
  ) {}

  async resolveOrRegisterScmRepositoryIdentity(
    facts: TrustedScmRepositoryFacts,
  ) {
    const externalIdentity = {
      provider: facts.provider,
      normalizedSourceBaseUrl: normalizeScmSourceBaseUrl(facts.sourceBaseUrl),
      externalRepositoryId: facts.externalRepositoryId,
    };
    const existing =
      await this.dependencies.identityQueries.findScmRepositoryIdentityByExternalIdentity(
        externalIdentity,
      );
    const identity: ScmRepositoryIdentity =
      existing ??
      createScmRepositoryIdentity({
        scmRepositoryIdentityId: this.dependencies.identifiers.nextId(
          "scm_repository_identity",
        ),
        ...facts,
        createdAt: this.dependencies.clock.now(),
      });
    return this.dependencies.identityCommands.resolveOrRegisterScmRepositoryIdentity(
      { identity },
    );
  }

  async bindScmRepositoryIdentity(input: {
    readonly scmRepositoryIdentityId: string;
    readonly expectedVersion: number;
    readonly workspaceId: string;
    readonly repositoryConnectionId: string;
  }) {
    return this.dependencies.identityCommands.bindScmRepositoryIdentity({
      ...input,
      boundAt: this.dependencies.clock.now(),
    });
  }

  async unbindScmRepositoryIdentity(input: {
    readonly scmRepositoryIdentityId: string;
    readonly expectedVersion: number;
  }) {
    const authority =
      await this.dependencies.authorityQueries.findReviewMutationAuthority({
        scmRepositoryIdentityId: input.scmRepositoryIdentityId,
        laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
      });
    if (!authority || authority.mode !== ReviewMutationMode.Paused) {
      return {
        status: ScmRepositoryIdentityBindingStatus.AuthorityNotPaused,
      } as const;
    }
    return this.dependencies.identityCommands.unbindScmRepositoryIdentity({
      ...input,
      unboundAt: this.dependencies.clock.now(),
      authority: {
        laneKind: authority.laneKind,
        expectedVersion: authority.version,
      },
    });
  }
}
