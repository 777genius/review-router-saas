// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import PrivacyPage from "./page";

afterEach(() => {
  cleanup();
});

describe("PrivacyPage", () => {
  it("publishes the Balanced Memory privacy boundary", () => {
    render(<PrivacyPage />);

    expect(
      screen.getByRole("heading", {
        name: "Memory is confirmed knowledge, not conversation custody.",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Confirmation required")).toBeTruthy();
    expect(screen.getByText("Distilled text only")).toBeTruthy();
    expect(screen.getByText("Scoped retrieval")).toBeTruthy();
    expect(screen.getByText("Admin export")).toBeTruthy();
    expect(
      screen.getByText(
        "raw memory source comments, embeddings, or deleted memory bodies in exports",
      ),
    ).toBeTruthy();
  });

  it("documents runtime removal before hard delete", () => {
    render(<PrivacyPage />);

    expect(
      screen.getByRole("heading", {
        name: "Runtime access stops before hard delete.",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Deleted memory")).toBeTruthy();
    expect(screen.getAllByText("not used at runtime").length).toBeGreaterThan(
      1,
    );
    expect(
      screen.getByText(
        "Deleted memory is excluded from export and runtime retrieval.",
        { exact: false },
      ),
    ).toBeTruthy();
  });
});
