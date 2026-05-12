import type { AuthenticatedPrincipal } from "@reviewrouter/features-auth";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  decryptServerToken,
  encryptServerToken,
  getTokenEncryptionStatus,
} from "./token-crypto";

const tokenRefreshSkewMs = 5 * 60 * 1000;
const githubOAuthTokenUrl = "https://github.com/login/oauth/access_token";

export type GitHubUserAuthorizationSaveStatus =
  | "saved"
  | "missing_token"
  | "token_encryption_misconfigured";

export type GitHubUserAccessTokenResult =
  | {
      readonly status: "ready";
      readonly accessToken: string;
      readonly refreshed: boolean;
    }
  | {
      readonly status:
        | "missing"
        | "revoked"
        | "expired"
        | "refresh_failed"
        | "token_decryption_failed"
        | "token_encryption_misconfigured";
      readonly errorCode?: string;
    };

export type GitHubOAuthAccountTokenInput = {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly expires_at?: unknown;
  readonly expires_in?: unknown;
  readonly refresh_token_expires_at?: unknown;
  readonly refresh_token_expires_in?: unknown;
};

type GitHubUserAuthorizationEnvironment = {
  readonly [key: string]: string | undefined;
};

type FetchLike = typeof fetch;

export async function saveGitHubUserAuthorizationFromAccount(input: {
  readonly prisma: PrismaClient;
  readonly principal: AuthenticatedPrincipal;
  readonly account: GitHubOAuthAccountTokenInput;
  readonly env?: GitHubUserAuthorizationEnvironment;
  readonly now?: Date;
}): Promise<GitHubUserAuthorizationSaveStatus> {
  const env = input.env ?? process.env;
  if (!getTokenEncryptionStatus(env).configured) {
    return "token_encryption_misconfigured";
  }

  const accessToken = readString(input.account.access_token);
  if (!accessToken) return "missing_token";

  const now = input.now ?? new Date();
  const refreshToken = readString(input.account.refresh_token);
  const appSlug = resolveGitHubUserAuthorizationAppSlug(env);

  await input.prisma.gitHubUserAuthorization.upsert({
    where: {
      userId_appSlug: {
        userId: input.principal.userId,
        appSlug,
      },
    },
    update: {
      githubUserId: BigInt(input.principal.githubUserId),
      encryptedAccessToken: encryptServerToken(accessToken, env),
      encryptedRefreshToken: refreshToken
        ? encryptServerToken(refreshToken, env)
        : null,
      accessTokenExpiresAt: resolveAccessTokenExpiresAt({
        account: input.account,
        now,
      }),
      refreshTokenExpiresAt: resolveRefreshTokenExpiresAt({
        account: input.account,
        now,
      }),
      revokedAt: null,
      lastErrorCode: null,
    },
    create: {
      userId: input.principal.userId,
      githubUserId: BigInt(input.principal.githubUserId),
      appSlug,
      encryptedAccessToken: encryptServerToken(accessToken, env),
      encryptedRefreshToken: refreshToken
        ? encryptServerToken(refreshToken, env)
        : null,
      accessTokenExpiresAt: resolveAccessTokenExpiresAt({
        account: input.account,
        now,
      }),
      refreshTokenExpiresAt: resolveRefreshTokenExpiresAt({
        account: input.account,
        now,
      }),
    },
  });

  return "saved";
}

export async function getValidGitHubUserAccessToken(input: {
  readonly prisma: PrismaClient;
  readonly userId: string;
  readonly env?: GitHubUserAuthorizationEnvironment;
  readonly now?: Date;
  readonly fetch?: FetchLike;
}): Promise<GitHubUserAccessTokenResult> {
  const env = input.env ?? process.env;
  if (!getTokenEncryptionStatus(env).configured) {
    return { status: "token_encryption_misconfigured" };
  }

  const appSlug = resolveGitHubUserAuthorizationAppSlug(env);
  const authorization = await input.prisma.gitHubUserAuthorization.findUnique({
    where: { userId_appSlug: { userId: input.userId, appSlug } },
  });
  if (!authorization) return { status: "missing" };
  if (authorization.revokedAt) {
    return {
      status: "revoked",
      ...(authorization.lastErrorCode
        ? { errorCode: authorization.lastErrorCode }
        : {}),
    };
  }

  const now = input.now ?? new Date();
  if (
    !authorization.accessTokenExpiresAt ||
    authorization.accessTokenExpiresAt.getTime() - now.getTime() >
      tokenRefreshSkewMs
  ) {
    try {
      return {
        status: "ready",
        accessToken: decryptServerToken(
          authorization.encryptedAccessToken,
          env,
        ),
        refreshed: false,
      };
    } catch {
      await markGitHubUserAuthorizationError({
        prisma: input.prisma,
        userId: input.userId,
        appSlug,
        errorCode: "github_user_token_decryption_failed",
        revoke: false,
      });
      return {
        status: "token_decryption_failed",
        errorCode: "github_user_token_decryption_failed",
      };
    }
  }

  if (!authorization.encryptedRefreshToken) {
    await expireGitHubUserAuthorization({
      prisma: input.prisma,
      userId: input.userId,
      appSlug,
      errorCode: "github_user_token_expired",
    });
    return { status: "expired", errorCode: "github_user_token_expired" };
  }

  if (
    authorization.refreshTokenExpiresAt &&
    authorization.refreshTokenExpiresAt.getTime() <= now.getTime()
  ) {
    await expireGitHubUserAuthorization({
      prisma: input.prisma,
      userId: input.userId,
      appSlug,
      errorCode: "github_user_refresh_token_expired",
      revoke: true,
    });
    return {
      status: "expired",
      errorCode: "github_user_refresh_token_expired",
    };
  }

  let refreshToken: string;
  try {
    refreshToken = decryptServerToken(authorization.encryptedRefreshToken, env);
  } catch {
    await markGitHubUserAuthorizationError({
      prisma: input.prisma,
      userId: input.userId,
      appSlug,
      errorCode: "github_user_refresh_token_decryption_failed",
      revoke: false,
    });
    return {
      status: "token_decryption_failed",
      errorCode: "github_user_refresh_token_decryption_failed",
    };
  }

  const refreshed = await refreshGitHubUserAccessToken({
    refreshToken,
    env,
    now,
    fetch: input.fetch ?? fetch,
  });
  if (!refreshed.ok) {
    await markGitHubUserAuthorizationError({
      prisma: input.prisma,
      userId: input.userId,
      appSlug,
      errorCode: refreshed.errorCode,
      revoke: refreshed.revoke,
    });
    if (refreshed.revoke) {
      await input.prisma.repositoryPermissionCache.deleteMany({
        where: { userId: input.userId },
      });
    }
    return { status: "refresh_failed", errorCode: refreshed.errorCode };
  }

  await input.prisma.gitHubUserAuthorization.update({
    where: { userId_appSlug: { userId: input.userId, appSlug } },
    data: {
      encryptedAccessToken: encryptServerToken(refreshed.accessToken, env),
      encryptedRefreshToken: refreshed.refreshToken
        ? encryptServerToken(refreshed.refreshToken, env)
        : authorization.encryptedRefreshToken,
      accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
      refreshTokenExpiresAt:
        refreshed.refreshTokenExpiresAt ?? authorization.refreshTokenExpiresAt,
      revokedAt: null,
      lastErrorCode: null,
    },
  });

  return {
    status: "ready",
    accessToken: refreshed.accessToken,
    refreshed: true,
  };
}

export async function revokeGitHubUserAuthorization(input: {
  readonly prisma: PrismaClient;
  readonly githubUserId: string | number | bigint;
  readonly errorCode?: string;
  readonly env?: GitHubUserAuthorizationEnvironment;
}): Promise<void> {
  const appSlug = resolveGitHubUserAuthorizationAppSlug(
    input.env ?? process.env,
  );
  const users = await input.prisma.user.findMany({
    where: { githubUserId: BigInt(input.githubUserId) },
    select: { id: true },
  });
  if (users.length === 0) return;

  const userIds = users.map((user) => user.id);
  await input.prisma.$transaction([
    input.prisma.gitHubUserAuthorization.updateMany({
      where: {
        appSlug,
        userId: { in: userIds },
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        lastErrorCode: input.errorCode ?? "github_app_authorization_revoked",
      },
    }),
    input.prisma.repositoryPermissionCache.deleteMany({
      where: { userId: { in: userIds } },
    }),
  ]);
}

export function resolveGitHubUserAuthorizationAppSlug(
  env: GitHubUserAuthorizationEnvironment = process.env,
): string {
  return (
    env.GITHUB_APP_SLUG?.trim() ||
    env.GITHUB_APP_CLIENT_ID?.trim() ||
    "github-app"
  );
}

async function refreshGitHubUserAccessToken(input: {
  readonly refreshToken: string;
  readonly env: GitHubUserAuthorizationEnvironment;
  readonly now: Date;
  readonly fetch: FetchLike;
}): Promise<
  | {
      readonly ok: true;
      readonly accessToken: string;
      readonly refreshToken: string | null;
      readonly accessTokenExpiresAt: Date | null;
      readonly refreshTokenExpiresAt: Date | null;
    }
  | {
      readonly ok: false;
      readonly errorCode: string;
      readonly revoke: boolean;
    }
> {
  const clientId = input.env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = input.env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      errorCode: "github_oauth_client_misconfigured",
      revoke: false,
    };
  }

  let response: Response;
  try {
    response = await input.fetch(githubOAuthTokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      }),
    });
  } catch {
    return {
      ok: false,
      errorCode: "github_user_token_refresh_network_error",
      revoke: false,
    };
  }

  const body = (await response.json().catch(() => ({}))) as {
    readonly access_token?: unknown;
    readonly refresh_token?: unknown;
    readonly expires_in?: unknown;
    readonly refresh_token_expires_in?: unknown;
    readonly error?: unknown;
  };
  if (!response.ok || typeof body.error === "string") {
    return {
      ok: false,
      errorCode:
        typeof body.error === "string"
          ? `github_user_token_refresh_${body.error}`
          : "github_user_token_refresh_failed",
      revoke: response.status === 400 || response.status === 401,
    };
  }

  const accessToken = readString(body.access_token);
  if (!accessToken) {
    return {
      ok: false,
      errorCode: "github_user_token_refresh_missing_access_token",
      revoke: false,
    };
  }

  return {
    ok: true,
    accessToken,
    refreshToken: readString(body.refresh_token),
    accessTokenExpiresAt: secondsFromNow(body.expires_in, input.now),
    refreshTokenExpiresAt: secondsFromNow(
      body.refresh_token_expires_in,
      input.now,
    ),
  };
}

async function markGitHubUserAuthorizationError(input: {
  readonly prisma: PrismaClient;
  readonly userId: string;
  readonly appSlug: string;
  readonly errorCode: string;
  readonly revoke: boolean;
}): Promise<void> {
  await input.prisma.gitHubUserAuthorization.updateMany({
    where: {
      userId: input.userId,
      appSlug: input.appSlug,
    },
    data: {
      lastErrorCode: input.errorCode,
      ...(input.revoke ? { revokedAt: new Date() } : {}),
    },
  });
}

async function expireGitHubUserAuthorization(input: {
  readonly prisma: PrismaClient;
  readonly userId: string;
  readonly appSlug: string;
  readonly errorCode: string;
  readonly revoke?: boolean;
}): Promise<void> {
  await input.prisma.$transaction([
    input.prisma.gitHubUserAuthorization.updateMany({
      where: {
        userId: input.userId,
        appSlug: input.appSlug,
      },
      data: {
        lastErrorCode: input.errorCode,
        ...(input.revoke ? { revokedAt: new Date() } : {}),
      },
    }),
    input.prisma.repositoryPermissionCache.deleteMany({
      where: { userId: input.userId },
    }),
  ]);
}

function resolveAccessTokenExpiresAt(input: {
  readonly account: GitHubOAuthAccountTokenInput;
  readonly now: Date;
}): Date | null {
  const epochSeconds = readNumber(input.account.expires_at);
  if (epochSeconds !== null) return new Date(epochSeconds * 1000);

  return secondsFromNow(input.account.expires_in, input.now);
}

function resolveRefreshTokenExpiresAt(input: {
  readonly account: GitHubOAuthAccountTokenInput;
  readonly now: Date;
}): Date | null {
  const epochSeconds = readNumber(input.account.refresh_token_expires_at);
  if (epochSeconds !== null) return new Date(epochSeconds * 1000);

  return secondsFromNow(input.account.refresh_token_expires_in, input.now);
}

function secondsFromNow(value: unknown, now: Date): Date | null {
  const seconds = readNumber(value);
  if (seconds === null) return null;
  return new Date(now.getTime() + seconds * 1000);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}
