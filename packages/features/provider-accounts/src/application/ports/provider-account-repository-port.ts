import type { PersonalAccountIntent } from "../use-cases/personal-account-operations";
import type { PersonalGatewayAccount } from "./provider-account-synchronization-port";
import type {
  BindingScope,
  BindingState,
  ProviderAccountConnection,
  WorkspaceAccountBinding,
} from "../../domain/provider-account";

export interface ProviderAccountRepositoryPort {
  findOwnedConnection(
    scope: BindingScope,
  ): Promise<ProviderAccountConnection | null>;
  findBinding(input: {
    readonly workspaceId: string;
    readonly bindingId: string;
  }): Promise<{
    readonly binding: WorkspaceAccountBinding;
    readonly connection: ProviderAccountConnection;
  } | null>;
  /** Atomically recheck owner + state and CAS. 0 creates only an absent active binding.
   * Revoked rows are retained to prevent ABA. Revocation can clean up inactive accounts.
   * Failure must throw a safe ProviderAccountError; never overwrite a stale revision.
   */
  compareAndSetBinding(
    input: BindingScope & {
      readonly expectedRevision: number;
      readonly state: BindingState;
    },
  ): Promise<WorkspaceAccountBinding>;
}

/** Trusted server capability. Rechecks actual operator membership under lock;
 * no login override, entitlement, or recipient-admin authority can issue grants.
 */
export interface OperatorAccountGrantRepositoryPort {
  compareAndSetOperatorBinding(
    input: BindingScope & {
      readonly expectedRevision: number;
      readonly state: BindingState;
      readonly actor: {
        readonly userId?: string | undefined;
        readonly githubUserId: string;
      };
    },
  ): Promise<WorkspaceAccountBinding>;
}

/** Accounts management and bounded display queries. Never authorize an account use. */
export interface ProviderAccountAccountsQueryPort extends ProviderAccountRepositoryPort {
  /** Bounded safe discovery of explicit grants; never a source of use authority. */
  listOperatorGrantedBindings?(input: {
    readonly workspaceId: string;
    readonly limit: number;
    readonly afterBindingId?: string;
  }): Promise<
    readonly {
      readonly binding: WorkspaceAccountBinding;
      readonly connection: ProviderAccountConnection;
    }[]
  >;
  /** Accounts-only local denial, after live server admin authorization.
   * Lock the owned connection and check its mirror CAS before inspecting bindings.
   * Absence creates + revokes in one transaction; retain a revoked pending fence.
   * Never change remote metadata or relax interactive binding expectedRevision.
   */
  denyOwnedConnectionForDisable(
    input: BindingScope & {
      readonly expectedMetadataRevision: number;
    },
  ): Promise<WorkspaceAccountBinding>;
  findOwnedConnectionByGatewayRef(input: {
    readonly workspaceId: string;
    readonly gatewayAccountRef: string;
  }): Promise<ProviderAccountConnection | null>;
  /** Legacy display: active-first, deterministic retired fallback; no personal lineage. */
  findConnectionBinding(
    scope: BindingScope,
  ): Promise<WorkspaceAccountBinding | null>;
}

// One cohesive, disabled personal-operation store; no generic operation router.
export type PersonalOperationResult = {
  readonly id: string;
  readonly intent: PersonalAccountIntent;
  readonly phase: "reserved" | "submitted" | "unknown" | "rejected" | "applied";
  readonly source: ProviderAccountConnection | null;
  readonly binding: WorkspaceAccountBinding | null;
  readonly available: boolean;
};
export interface PersonalAccountOperationStore {
  resolvePersonalWorkspace(actorUserId: string): Promise<string>;
  findOwnedSource(
    actorUserId: string,
    sourceId: string,
  ): Promise<ProviderAccountConnection>;
  reserveConnect(
    intent: PersonalAccountIntent & {
      action: "connect";
    },
  ): Promise<PersonalOperationResult>;
  claimConnect(
    actorUserId: string,
    clientOperationId: string,
  ): Promise<boolean>;
  readOperation(
    actorUserId: string,
    clientOperationId: string,
  ): Promise<PersonalOperationResult>;
  noteConnectPhase(
    actorUserId: string,
    clientOperationId: string,
    phase: "unknown" | "rejected",
  ): Promise<void>;
  /** Projection must match the original Gateway operation result; never a later GET tuple. */
  finalizeConnect(
    actorUserId: string,
    clientOperationId: string,
    account: PersonalGatewayAccount,
  ): Promise<PersonalOperationResult>;
  attach(
    intent: PersonalAccountIntent & {
      action: "attach";
    },
  ): Promise<PersonalOperationResult>;
  revoke(
    intent: PersonalAccountIntent & {
      action: "revoke";
    },
  ): Promise<PersonalOperationResult>;
  /** Finite future writer seam, presently unused by create/no-op auth/install writers.
   * Authenticated local admin, exact member CAS; mutation and retirement commit together.
   */
  changeEligibility(input: {
    actorUserId: string;
    workspaceId: string;
    memberId: string;
    userId: string;
    expectedRole: "owner" | "admin" | "member";
    nextRole: "owner" | "admin" | "member" | null;
    nextUserId?: string;
  }): Promise<void>;
}
