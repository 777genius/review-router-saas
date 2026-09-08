import { rmSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupHistorical89RecoveryFixture } from "./render-historical89-recovery-cleanup.fixture";

vi.mock("node:fs", () => ({ rmSync: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it.each(["container", "directory", "both", "none"])(
  "restores PATH and preserves cleanup behavior on %s failure",
  (failure) => {
    const originalPath = process.env.PATH;
    const controlledPath = `${originalPath ?? ""}:/mock/controlled`;
    const directoryError = new Error("directory removal failed");
    const attempted: string[] = [];
    const containers = ["target1", "target2", "source", "referenceModel"].map(
      (name) => ({
        cleanup() {
          expect(process.env.PATH).toBe(controlledPath);
          attempted.push(name);
          if (
            (failure === "container" || failure === "both") &&
            name !== "referenceModel"
          )
            throw new Error(`identity failure: ${name}`);
        },
      }),
    );
    vi.mocked(rmSync).mockImplementation(() => {
      expect(process.env.PATH).toBe(controlledPath);
      if (failure === "directory" || failure === "both") throw directoryError;
    });
    vi.stubEnv("PATH", controlledPath);

    const cleanup = () =>
      cleanupHistorical89RecoveryFixture(containers, "/mock/recovery");
    if (failure === "directory" || failure === "both") {
      let caught: unknown;
      try {
        cleanup();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(directoryError);
    } else if (failure === "container") {
      expect(cleanup).toThrow(new Error("recovery_fixture_cleanup_failed"));
    } else {
      expect(cleanup).not.toThrow();
    }

    // Assert before the safety afterEach, so a missing finally cannot pass.
    expect(process.env.PATH).toBe(originalPath);
    expect(attempted).toEqual(["target1", "target2", "source", "referenceModel"]);
    expect(rmSync).toHaveBeenCalledExactlyOnceWith("/mock/recovery", {
      recursive: true,
      force: true,
    });
  },
);

it("restores PATH when setup did not create a directory", () => {
  const originalPath = process.env.PATH;
  const controlledPath = `${originalPath ?? ""}:/mock/controlled`;
  vi.stubEnv("PATH", controlledPath);
  cleanupHistorical89RecoveryFixture([], undefined);
  expect(process.env.PATH).toBe(originalPath);
  expect(rmSync).not.toHaveBeenCalled();
});
