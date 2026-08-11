import { readLocalRotatingInstallerSource } from "@/server/codex-rotating-seed-script";

export function GET(): Response {
  return new Response(readLocalRotatingInstallerSource(), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
