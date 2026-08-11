import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/codex-rotating-seed-script", () => ({
  readLocalRotatingInstallerSource: () => "#!/usr/bin/env bash\nexit 0\n",
}));

import { GET } from "./route";

describe("Codex rotating installer endpoint", () => {
  it("serves the local pinned installer without a redirect", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe(
      "text/x-shellscript; charset=utf-8",
    );
    await expect(response.text()).resolves.toBe(
      "#!/usr/bin/env bash\nexit 0\n",
    );
  });
});
