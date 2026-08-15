import { z } from "zod";
import type { InvocationGrantId } from "../../domain/identifiers";
import {
  consumeCommentTokenRefreshCapability as consumeTransition,
  revokeCommentTokenRefreshCapability as revokeTransition,
  type CommentTokenRefreshConsumption,
  type InvocationGrant,
} from "../../domain/invocation-grant";
import type { CommentTokenRefreshCapabilityPort } from "../ports/comment-token-refresh-capability-port";

export function consumeHostedCommentTokenRefreshCapability(
  input: {
    readonly grantId: InvocationGrantId;
    readonly presentedTokenHash: string;
    readonly requestIdHash: string;
    readonly now: Date;
  },
  capabilities: CommentTokenRefreshCapabilityPort,
): Promise<CommentTokenRefreshConsumption> {
  return capabilities.consume({
    grantId: input.grantId,
    presentedTokenHash: z
      .string()
      .trim()
      .min(16)
      .max(512)
      .parse(input.presentedTokenHash),
    requestIdHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .parse(input.requestIdHash),
    now: input.now,
    transition: (grant) => consumeTransition({ grant, now: input.now }),
  });
}

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
