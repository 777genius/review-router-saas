import type {
  ConnectionMetadata,
  ProviderAccountConnection,
} from "../../domain/provider-account";

/** Privileged gateway-status synchronization only. Compose on the trusted backend,
 * never as a browser metadata mutation. No account creation/reconnect/credential effect.
 */
export interface ProviderAccountSynchronizationPort {
  recordWorkspaceConnection(
    input: ConnectionMetadata & {
      readonly id: string;
      readonly workspaceId: string;
      readonly gatewayAccountRef: string;
    },
  ): Promise<ProviderAccountConnection>;
  synchronizeMetadata(
    input: ConnectionMetadata & {
      readonly workspaceId: string;
      readonly connectionId: string;
      readonly expectedRevision: number;
    },
  ): Promise<ProviderAccountConnection>;
}

/** Safe exact Gateway projection. The adapter verifies derived stable User ownership. */
export type PersonalGatewayAccount = {
  readonly accountRef: string;
  readonly profileId: string;
  readonly displayName: string;
  readonly state: string;
  readonly metadataRevision: number;
  readonly authorizationEpoch: number;
};
export interface PersonalAccountGatewayPort {
  get(
    actorUserId: string,
    accountRef: string,
    profileId: string,
  ): Promise<PersonalGatewayAccount>;
  operation(operationId: string): Promise<{
    operationId: string;
    state: "pending" | "applied" | "rejected" | "unknown";
    result?: {
      accountRef: string;
      metadataRevision: number;
      authorizationEpoch: number;
    };
  }>;
}
