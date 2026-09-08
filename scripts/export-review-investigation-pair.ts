import { constants } from "node:fs";
import { open, lstat, link, unlink } from "node:fs/promises";
import { dirname, basename, resolve, join, parse } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  readExactReviewInvestigationPair,
  validateSelection,
  type TrustedPairScope,
} from "./lib/review-investigation-pair-export";

// Fixed administrator-controlled policy: selectors cannot choose their own authority.
const policyPath = "/etc/reviewrouter/review-investigation-pair-scope.json";
async function checkPath(path: string, rootOwned = false) {
  const absolute = resolve(path);
  let part = parse(absolute).root;
  for (const component of absolute
    .slice(part.length)
    .split("/")
    .filter(Boolean)) {
    part = join(part, component);
    const stat = await lstat(part);
    if (
      stat.isSymbolicLink() ||
      (rootOwned && (stat.uid !== 0 || (stat.mode & 0o022) !== 0))
    )
      throw new Error("denied");
  }
  return absolute;
}
export async function readBoundedJson(
  path: string,
  trusted = false,
): Promise<unknown> {
  await checkPath(path, trusted);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 16384 ||
      (trusted && (stat.uid !== 0 || (stat.mode & 0o022) !== 0))
    )
      throw new Error("denied");
    const bytes = Buffer.alloc(16385);
    let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > 16384) throw new Error("denied");
    return JSON.parse(bytes.subarray(0, size).toString("utf8"));
  } finally {
    await file.close();
  }
}
/** Linux operator environment. Directory descriptor anchors writes against parent replacement. */
export async function writeRestrictedArtifact(path: string, artifact: unknown) {
  const absolute = resolve(path);
  await checkPath(dirname(absolute));
  const directory = await open(
    dirname(absolute),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let temporary: string | undefined;
  try {
    const stat = await directory.stat();
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("denied");
    const anchored = `/proc/self/fd/${directory.fd}`;
    temporary = `${anchored}/.pair-${randomUUID()}.tmp`;
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify(artifact) + "\n", "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    // Hard link publishes complete content atomically and refuses any existing entry, including symlinks.
    await link(temporary, `${anchored}/${basename(absolute)}`);
    await unlink(temporary);
    temporary = undefined;
    await directory.sync();
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    await directory.close();
  }
}
export async function main(args: string[]): Promise<number> {
  try {
    if (
      args.length !== 4 ||
      args[0] !== "--manifest" ||
      args[2] !== "--output" ||
      args.some((v) => v.length > 4096)
    )
      throw new Error("denied");
    const trusted = (await readBoundedJson(
      policyPath,
      true,
    )) as TrustedPairScope;
    const selection = validateSelection(
      await readBoundedJson(args[1]!),
      trusted,
      Date.now(),
    );
    const { createPrismaClient } =
      await import("../packages/platform/db/src/index");
    const { PrismaReviewObservationStore } =
      await import("../packages/features/review-evidence/src/infrastructure/prisma/prisma-review-observation-store");
    const { PrismaInvestigationShadowEvidenceStore } =
      await import("../packages/features/review-evidence/src/infrastructure/prisma/prisma-investigation-shadow-evidence-store");
    const prisma = createPrismaClient();
    try {
      const artifact = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
          // Existing stores accept PrismaClient but exact reads only need transaction delegates.
          const client = tx as unknown as typeof prisma;
          return readExactReviewInvestigationPair(
            selection,
            trusted,
            {
              observations: new PrismaReviewObservationStore(client),
              shadows: new PrismaInvestigationShadowEvidenceStore(client),
            },
            Date.now(),
          );
        },
        { isolationLevel: "RepeatableRead", timeout: 15000, maxWait: 5000 },
      );
      await writeRestrictedArtifact(args[3]!, artifact);
    } finally {
      await prisma.$disconnect();
    }
    return 0;
  } catch {
    process.stderr.write("pair_export_unavailable_or_denied\n");
    return 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
