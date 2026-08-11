import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("retired Codex reseed bootstrap endpoint", () => {
  it("returns a failing dashboard handoff instead of a redirect or mutable script", async () => {
    const response = GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toBe(
      "text/x-shellscript; charset=utf-8",
    );
    expect(body).toContain("Dashboard");
    expect(body).toContain("exit 1");
    expect(body).not.toContain("curl");
    expect(body).not.toContain("main");
  });
});
