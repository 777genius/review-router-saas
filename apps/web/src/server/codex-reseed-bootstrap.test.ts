import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Codex reseed bootstrap", () => {
  it("keeps the GitHub token out of curl argv and executes the issued command", () => {
    const root = mkdtempSync(join(tmpdir(), "rr-reseed-bootstrap-"));
    try {
      const bin = join(root, "bin");
      const marker = join(root, "marker.txt");
      const capture = join(root, "capture.json");
      mkdirSync(bin);
      writeExecutable(
        join(bin, "gh"),
        "#!/usr/bin/env bash\nprintf '%s\\n' 'github-token-value'\n",
      );
      writeExecutable(
        join(bin, "curl"),
        `#!/usr/bin/env bash
set -euo pipefail
out=""
header_file=""
args="$*"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) shift; out="$1" ;;
    --header)
      shift
      case "$1" in @*) header_file="\${1#@}" ;; esac
      ;;
  esac
  shift
done
[ -n "$out" ]
[ -n "$header_file" ]
if printf '%s' "$args" | grep -q 'github-token-value'; then exit 41; fi
if ! grep -q '^Authorization: Bearer github-token-value$' "$header_file"; then exit 42; fi
node - "$out" "$RESEED_TEST_MARKER" "$RESEED_TEST_CAPTURE" <<'NODE'
const fs = require("node:fs");
const [out, marker, capture] = process.argv.slice(2);
fs.writeFileSync(out, JSON.stringify({
  command: "printf '%s\\\\n' complete > " + JSON.stringify(marker),
  expiresAt: "2026-07-15T17:00:00.000Z",
  providerInstanceId: "codex-rotating:1185393047",
}));
fs.writeFileSync(capture, JSON.stringify({ tokenInArgv: false }));
NODE
printf '200'
`,
      );

      const result = spawnSync(
        "bash",
        [
          join(process.cwd(), "scripts/reseed-codex-rotating-auth.sh"),
          "--repo",
          "Padelapp-Club/monorepository",
          "--reuse-current-auth",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            RESEED_TEST_MARKER: marker,
            RESEED_TEST_CAPTURE: capture,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("complete\n");
      expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
        tokenInArgv: false,
      });
      expect(result.stdout).not.toContain("github-token-value");
      expect(result.stderr).not.toContain("github-token-value");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}
