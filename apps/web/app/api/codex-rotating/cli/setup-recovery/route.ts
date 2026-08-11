import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertCodexRotatingSetupRecoveryHttpFields,
  codexRotatingSetupRecoveryHttpStatus,
  codexRotatingSetupRecoveryRequestIdSchema,
  safeCodexRotatingSetupRecoveryErrorCode,
} from "@reviewrouter/features-provider-setup";
import { authorizeGitHubCliRepository } from "../../../../../src/server/github-cli-repository-authorization";
import { getPrisma } from "../../../../../src/server/prisma";
import { recoverAndIssueCodexRotatingSetup } from "../../../../../src/server/codex-rotating-setup-recovery";

const requestSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    acknowledgement: z.enum([
      "all_prior_installers_and_writers_are_stopped",
      "all_prior_installers_and_writers_are_stopped_and_account_switch_is_intended",
    ]),
    accountSwitch: z.boolean().optional().default(false),
    recoveryRequestId: codexRotatingSetupRecoveryRequestIdSchema,
  })
  .strict();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const accessToken = readBearerToken(request);
    const rawBody: unknown = await request.json();
    const parsed = requestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const fields =
        typeof rawBody === "object" && rawBody
          ? (rawBody as {
              acknowledgement?: unknown;
              accountSwitch?: unknown;
              recoveryRequestId?: unknown;
            })
          : {};
      assertCodexRotatingSetupRecoveryHttpFields({
        acknowledgement: fields.acknowledgement,
        accountSwitch: fields.accountSwitch,
        recoveryRequestId: fields.recoveryRequestId,
      });
      throw new Error("invalid_request");
    }
    const body = parsed.data;
    assertCodexRotatingSetupRecoveryHttpFields({
      acknowledgement: body.acknowledgement,
      accountSwitch: body.accountSwitch,
      recoveryRequestId: body.recoveryRequestId,
    });
    const authorized = await authorizeGitHubCliRepository({
      accessToken,
      repositoryFullName: body.repository,
    });
    const prisma = getPrisma();
    const repository = await prisma.repositoryConnection.findFirst({
      where: {
        provider: "github",
        githubRepositoryId: BigInt(authorized.githubRepositoryId),
      },
      select: {
        id: true,
        workspaceId: true,
        provider: true,
        githubRepositoryId: true,
        fullName: true,
        selected: true,
        archived: true,
        installation: { select: { status: true } },
      },
    });
    if (!repository) throw new Error("repository_not_found");
    if (
      repository.fullName.toLowerCase() !== authorized.fullName.toLowerCase()
    ) {
      throw new Error("repository_mismatch");
    }
    const result = await recoverAndIssueCodexRotatingSetup({
      prisma,
      repository,
      actor: `github-cli:token-sha256:${createHash("sha256")
        .update(accessToken)
        .digest("hex")}`,
      recoveryRequestId: body.recoveryRequestId,
      acknowledgement: body.acknowledgement,
      accountSwitch: body.accountSwitch,
    });
    return NextResponse.json(
      {
        command: result.command,
        expiresAt: result.expiresAt,
        providerInstanceId: result.providerInstanceId,
        recoveryStatus: result.recoveryStatus,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const code = safeCodexRotatingSetupRecoveryErrorCode(error);
    return NextResponse.json(
      { error: code },
      {
        status: codexRotatingSetupRecoveryHttpStatus(code),
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

function readBearerToken(request: Request): string {
  const match = (request.headers.get("authorization") ?? "").match(
    /^Bearer\s+(\S+)$/i,
  );
  const token = match?.[1];
  if (!token || token.length < 16 || token.length > 4096) {
    throw new Error("github_cli_token_required");
  }
  return token;
}
