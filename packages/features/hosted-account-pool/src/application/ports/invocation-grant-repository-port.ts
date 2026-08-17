import type { InvocationGrant } from "../../domain/invocation-grant";
import type { InvocationGrantId, InvocationId } from "../../domain/identifiers";

export interface InvocationGrantRepositoryPort {
  findByInvocationId(
    invocationId: InvocationId,
  ): Promise<InvocationGrant | null>;
  insert(grant: InvocationGrant): Promise<void>;
  /** Adapter must serialize this mutation (transaction/row lock/CAS). */
  mutate(
    grantId: InvocationGrantId,
    transition: (current: InvocationGrant) => InvocationGrant,
  ): Promise<InvocationGrant>;
}
