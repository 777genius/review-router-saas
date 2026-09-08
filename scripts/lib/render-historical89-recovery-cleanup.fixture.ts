import { rmSync } from "node:fs";
import { vi } from "vitest";

// Test-only teardown shared with the bounded failure regression.
export function cleanupHistorical89RecoveryFixture(
  containers: readonly { cleanup(): void }[],
  root: string | undefined,
): void {
  try {
    // Attempt every cleanup even if one container reports an identity failure.
    const errors: unknown[] = [];
    for (const pg of containers) {
      try {
        pg.cleanup();
      } catch (e) {
        errors.push(e);
      }
    }
    if (root) rmSync(root, { recursive: true, force: true });
    if (errors.length) throw new Error("recovery_fixture_cleanup_failed");
  } finally {
    // Vitest may stop after a failed afterAll; restore within the cleanup hook.
    vi.unstubAllEnvs();
  }
}
