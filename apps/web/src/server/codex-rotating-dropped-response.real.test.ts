import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const routeDependencies = vi.hoisted(() => ({
  prisma: undefined as PrismaClient | undefined,
}));

vi.mock("./prisma", () => ({
  getPrisma: () => routeDependencies.prisma,
}));

import { POST as confirmSetupRoute } from "../../app/api/codex-rotating/setup-confirm/route";
import {
  issueCodexRotatingSetupCommand,
  resolveCodexRotatingSetupManifestForNonce,
} from "./codex-rotating-setup-manifest";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
if (
  process.env.REVIEW_ROUTER_CODEX_ROTATING_LOOPBACK_PROOF === "1" &&
  !databaseUrl
) {
  throw new Error(
    "REVIEW_ROUTER_TEST_DATABASE_URL is required for the rotating setup loopback proof",
  );
}
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("rotating setup dropped HTTP response", () => {
  let prisma: PrismaClient;
  const suffix = randomUUID();
  const workspaceId = `drop-workspace-${suffix}`;
  const repositoryId = `drop-repository-${suffix}`;
  const githubRepositoryId = `8${Date.now()}`;
  const repositoryFullName = "local/drop-proof";

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: databaseUrl! });
    routeDependencies.prisma = prisma;
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `drop-${suffix}`,
        name: "Dropped response proof",
      },
    });
    await prisma.repositoryConnection.create({
      data: {
        id: repositoryId,
        workspaceId,
        provider: "github",
        externalRepositoryId: githubRepositoryId,
        githubRepositoryId: BigInt(githubRepositoryId),
        owner: "local",
        name: "drop-proof",
        fullName: repositoryFullName,
        defaultBranch: "main",
        visibility: "private",
      },
    });
  });

  afterAll(async () => {
    routeDependencies.prisma = undefined;
    if (!prisma) return;
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.$disconnect();
  });

  it("commits once, drops the first socket response, and accepts a byte-identical retry", async () => {
    await withRotatingRepositoryAllowed(repositoryFullName, async () => {
      const installerPath = join(
        process.cwd(),
        "scripts/seed-codex-rotating-auth.sh",
      );
      const installerSha256 = createHash("sha256")
        .update(readFileSync(installerPath))
        .digest("hex");
      await prisma.codexOAuthProviderInstance.create({
        data: {
          workspaceId,
          repositoryId,
          providerInstanceId: `codex-rotating:${githubRepositoryId}`,
          authMode: "codex_subscription_oauth_rotating",
          secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
          state: "active",
          latestGeneration: 7,
          latestGenerationHash: "old-generation",
          generationHashSalt: Buffer.alloc(32, 17).toString("base64url"),
          accountFingerprintSalt: Buffer.alloc(32, 23).toString("base64url"),
        },
      });
      await issueCodexRotatingSetupCommand({
        prisma,
        workspaceId,
        repositoryId,
        repositoryFullName,
        githubRepositoryId,
        installer: {
          url: "http://127.0.0.1/install/codex-rotating",
          version: "loopback-proof",
          sha256: installerSha256,
        },
        setupManifestUrl: "http://127.0.0.1/unused-manifest",
        setupConfirmUrl: "http://127.0.0.1/placeholder-confirm",
      });
      const row = await prisma.codexOAuthSetupManifest.findFirstOrThrow({
        where: { repositoryId, status: "issued" },
        select: { setupNonce: true },
      });
      const fetched = await resolveCodexRotatingSetupManifestForNonce({
        prisma,
        setupNonce: row.setupNonce,
      });

      const requestBodies: Buffer[] = [];
      const routeResults: Array<{ status: number; body: string }> = [];
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        requestBodies.push(body);
        const routeResponse = await confirmSetupRoute(
          new Request("http://127.0.0.1/api/codex-rotating/setup-confirm", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        );
        const routeBody = Buffer.from(await routeResponse.arrayBuffer());
        routeResults.push({
          status: routeResponse.status,
          body: routeBody.toString("utf8"),
        });
        if (requestBodies.length === 1) {
          process.env.REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH = "0";
          delete process.env.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES;
          request.socket.destroy();
          return;
        }
        response.statusCode = routeResponse.status;
        routeResponse.headers.forEach((value, name) =>
          response.setHeader(name, value),
        );
        response.end(routeBody);
      });
      await new Promise<void>((resolveListen) =>
        server.listen(0, "127.0.0.1", resolveListen),
      );

      const root = mkdtempSync(join(tmpdir(), "rr-drop-response-"));
      const bin = join(root, "bin");
      const home = join(root, "home");
      const codexHome = join(root, "codex-home");
      const ghEvents = join(root, "gh-events.log");
      mkdirSync(bin);
      mkdirSync(home);
      mkdirSync(codexHome);
      const bearer = "bearer-must-never-be-logged";
      const refresh = "refresh-must-never-be-logged";
      writeFileSync(
        join(codexHome, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { access_token: bearer, refresh_token: refresh },
        }),
      );
      writeExecutable(
        join(bin, "gh"),
        `#!/bin/bash\nprintf 'gh:%s\\n' "$*" >> "${ghEvents}"\nif [ "$1 $2" = "auth status" ]; then exit 0; fi\nif [ "$1" = api ]; then printf '${githubRepositoryId}\\n'; exit 0; fi\nif [ "$1 $2" = "secret set" ]; then cat >/dev/null; exit 0; fi\nexit 1\n`,
      );
      writeExecutable(join(bin, "codex"), "#!/bin/bash\nexit 0\n");
      writeExecutable(
        join(bin, "sha256sum"),
        "#!/usr/bin/env node\nimport c from 'node:crypto';import f from 'node:fs';const p=process.argv[2];console.log(c.createHash('sha256').update(f.readFileSync(p)).digest('hex')+'  '+p);\n",
      );

      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("loopback server did not expose a TCP port");
      let processResult;
      try {
        processResult = await runProcess(
          "bash",
          [
            installerPath,
            "--confirm-write",
            "--reuse-existing-auth-i-know-it-is-current",
            "--repo",
            repositoryFullName,
          ],
          {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            HOME: home,
            REVIEW_ROUTER_CODEX_HOME: codexHome,
            REVIEW_ROUTER_INSTALLER_URL:
              "http://127.0.0.1/install/codex-rotating",
            REVIEW_ROUTER_INSTALLER_VERSION: "loopback-proof",
            REVIEW_ROUTER_INSTALLER_SHA256: installerSha256,
            REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:
              fetched.manifestBase64,
            REVIEW_ROUTER_CODEX_ROTATING_SETUP_CONFIRM_URL: `http://127.0.0.1:${address.port}/api/codex-rotating/setup-confirm`,
          },
        );
      } finally {
        await new Promise<void>((resolveClose, rejectClose) =>
          server.close((error) =>
            error ? rejectClose(error) : resolveClose(),
          ),
        );
      }

      expect(processResult.status).toBe(0);
      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[1]!.equals(requestBodies[0]!)).toBe(true);
      expect(
        routeResults.map((result) => ({
          status: result.status,
          body: JSON.parse(result.body),
        })),
      ).toEqual([
        { status: 200, body: { status: "accepted" } },
        { status: 200, body: { status: "accepted" } },
      ]);
      expect(JSON.parse(requestBodies[0]!.toString("utf8"))).toMatchObject({
        repositoryId: githubRepositoryId,
        providerInstanceId: `codex-rotating:${githubRepositoryId}`,
      });
      const ghLog = readFileSync(ghEvents, "utf8");
      expect(ghLog.match(/^gh:secret set/gmu)).toHaveLength(1);
      expect(ghLog).toContain(`--repo ${repositoryFullName} --app actions`);
      expect(ghLog).toContain(`api repos/${repositoryFullName} --jq .id`);
      const combinedLogs = `${processResult.stdout}\n${processResult.stderr}\n${ghLog}`;
      expect(combinedLogs).not.toContain(bearer);
      expect(combinedLogs).not.toContain(refresh);
      await expect(
        prisma.codexOAuthProviderInstance.findUniqueOrThrow({
          where: { providerInstanceId: `codex-rotating:${githubRepositoryId}` },
          select: { latestGeneration: true },
        }),
      ).resolves.toEqual({ latestGeneration: 8 });
      await expect(
        prisma.codexOAuthSetupManifest.findUniqueOrThrow({
          where: { setupNonce: row.setupNonce },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: "consumed" });
    });
  }, 20_000);
});

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function runProcess(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolveRun) => {
      const child = spawn(command, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("exit", (status) => resolveRun({ status, stdout, stderr }));
    },
  );
}

async function withRotatingRepositoryAllowed<T>(
  repositoryFullName: string,
  run: () => Promise<T>,
): Promise<T> {
  const previousEnabled = process.env.REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH;
  const previousAllowlist =
    process.env.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES;
  process.env.REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH = "1";
  process.env.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES =
    repositoryFullName;
  try {
    return await run();
  } finally {
    restore("REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH", previousEnabled);
    restore(
      "REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES",
      previousAllowlist,
    );
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
