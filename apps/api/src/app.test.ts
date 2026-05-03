import { describe, expect, it } from "vitest";
import { createApiApp } from "./app.js";

describe("API app", () => {
  it("serves health status", async () => {
    const app = createApiApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "review-router-api",
      status: "ok",
    });
  });
});
