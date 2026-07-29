import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("web health route", () => {
  it("returns a non-cacheable 200 response without authentication", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      service: "review-router-web",
      status: "ok",
    });
  });
});
