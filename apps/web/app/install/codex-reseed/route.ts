const retiredReseedBootstrap = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'ReviewRouter: this mutable public reseed endpoint is retired.' >&2
printf '%s\n' 'Open the ReviewRouter Dashboard and copy the repository-specific Codex setup command.' >&2
exit 1
`;

export function GET(): Response {
  return new Response(retiredReseedBootstrap, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
