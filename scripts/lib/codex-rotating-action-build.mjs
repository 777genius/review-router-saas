import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const thirdPartyNotices = await readFile(
  new URL("../codex-rotating-action-third-party-licenses.txt", import.meta.url),
  "utf8",
);

export async function buildCodexRotatingAction({
  root = process.cwd(),
  outfile = join(root, "action-dist/index.cjs"),
} = {}) {
  await build({
    absWorkingDir: root,
    entryPoints: [
      "packages/features/codex-oauth-rotating/src/action/github-action.ts",
    ],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    legalComments: "none",
    banner: {
      js: `/*! ReviewRouter Action third-party notices\n${thirdPartyNotices.trimEnd()}\n*/`,
    },
  });
  const bundle = await readFile(outfile, "utf8");
  const reproducibleBundle = bundle.replace(
    /^\/\/ (?:.*\/)?node_modules\/[^\r\n]*(?:\r?\n|$)/gmu,
    "",
  );
  if (reproducibleBundle !== bundle) {
    await writeFile(outfile, reproducibleBundle);
  }
}
