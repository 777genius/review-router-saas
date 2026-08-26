import type { InvocationGrantId } from "../../domain/identifiers";
import {
  revokeCommentTokenRefreshCapability as revokeTransition,
  type InvocationGrant,
} from "../../domain/invocation-grant";
import type { CommentTokenRefreshCapabilityPort } from "../ports/comment-token-refresh-capability-port";

export function revokeHostedCommentTokenRefreshCapability(
  input: { readonly grantId: InvocationGrantId; readonly revokedAt: Date },
  capabilities: CommentTokenRefreshCapabilityPort,
): Promise<InvocationGrant> {
  return capabilities.revoke({
    ...input,
    transition: (grant) =>
      revokeTransition({ grant, revokedAt: input.revokedAt }),
  });
}
