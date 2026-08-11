// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import GettingStartedPage from "./page";

afterEach(() => {
  cleanup();
});

describe("GettingStartedPage", () => {
  it("directs users to the dashboard-generated verified command", () => {
    const { container } = render(<GettingStartedPage />);
    const text = container.textContent ?? "";

    expect(text).toContain("Copy and run the complete command generated there");
    expect(text).toContain("verifies its SHA-256");
    expect(text).not.toContain("| bash");
    expect(text).not.toContain("curl -fsSL ");
    expect(text).not.toContain("/install/codex-reseed");
  });
});
