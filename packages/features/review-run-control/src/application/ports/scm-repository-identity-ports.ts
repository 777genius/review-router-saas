import type {
  ScmRepositoryExternalIdentity,
  ScmRepositoryIdentity,
} from "../../domain/scm-repository-identity";
import type { ReviewMutationLaneKind } from "../../domain/review-run-control-types";

export enum ScmRepositoryIdentityResolveStatus {
  Created = "created",
  Restored = "restored",
}

export enum ScmRepositoryIdentityBindingStatus {
  Bound = "bound",
  Unbound = "unbound",
  Restored = "restored",
  Conflict = "conflict",
  Missing = "missing",
  AuthorityNotPaused = "authority_not_paused",
}

export interface ScmRepositoryIdentityQueryPort {
  findScmRepositoryIdentityById(
    scmRepositoryIdentityId: string,
  ): Promise<ScmRepositoryIdentity | null>;
  findScmRepositoryIdentityByExternalIdentity(
    identity: ScmRepositoryExternalIdentity,
  ): Promise<ScmRepositoryIdentity | null>;
}

export interface ScmRepositoryIdentityCommandPort {
  resolveOrRegisterScmRepositoryIdentity(input: {
    readonly identity: ScmRepositoryIdentity;
  }): Promise<{
    readonly status: ScmRepositoryIdentityResolveStatus;
    readonly identity: ScmRepositoryIdentity;
  }>;
  bindScmRepositoryIdentity(input: {
    readonly scmRepositoryIdentityId: string;
    readonly expectedVersion: number;
    readonly workspaceId: string;
    readonly repositoryConnectionId: string;
    readonly boundAt: Date;
  }): Promise<
    | {
        readonly status:
          | ScmRepositoryIdentityBindingStatus.Bound
          | ScmRepositoryIdentityBindingStatus.Restored;
        readonly identity: ScmRepositoryIdentity;
      }
    | {
        readonly status:
          | ScmRepositoryIdentityBindingStatus.Conflict
          | ScmRepositoryIdentityBindingStatus.Missing;
      }
  >;
  unbindScmRepositoryIdentity(input: {
    readonly scmRepositoryIdentityId: string;
    readonly expectedVersion: number;
    readonly unboundAt: Date;
    readonly authority: {
      readonly laneKind: ReviewMutationLaneKind;
      readonly expectedVersion: number;
    };
  }): Promise<
    | {
        readonly status:
          | ScmRepositoryIdentityBindingStatus.Unbound
          | ScmRepositoryIdentityBindingStatus.Restored;
        readonly identity: ScmRepositoryIdentity;
      }
    | {
        readonly status:
          | ScmRepositoryIdentityBindingStatus.Conflict
          | ScmRepositoryIdentityBindingStatus.Missing
          | ScmRepositoryIdentityBindingStatus.AuthorityNotPaused;
      }
  >;
}
