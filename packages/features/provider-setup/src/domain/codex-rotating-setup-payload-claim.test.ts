import { describe, expect, it } from "vitest";
import {
  codexRotatingSetupDispatchAuthorityTtlMs,
  reserveCodexRotatingSetupDispatchAuthorityWindow,
} from "./codex-rotating-setup-payload-claim";

describe("setup dispatch authority deadline", () => {
  it.each([-24, 0, 24])(
    "remains database time plus ten minutes under process skew %dh",
    (processSkewHours) => {
      const databaseNow = new Date("2026-08-10T00:00:00.000Z");
      const processNow = new Date(
        databaseNow.getTime() + processSkewHours * 60 * 60 * 1000,
      );
      expect(processNow).toBeInstanceOf(Date);

      const deadline =
        reserveCodexRotatingSetupDispatchAuthorityWindow(databaseNow);
      expect(deadline).toEqual(new Date("2026-08-10T00:10:00.000Z"));
      expect(deadline.getTime() - databaseNow.getTime()).toBe(
        codexRotatingSetupDispatchAuthorityTtlMs,
      );
    },
  );
});
