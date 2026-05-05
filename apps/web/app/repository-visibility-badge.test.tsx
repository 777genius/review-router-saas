// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryVisibilityBadge } from "./repository-visibility-badge";

describe("RepositoryVisibilityBadge", () => {
  afterEach(() => cleanup());

  it.each([
    ["public", "Public"],
    ["private", "Private"],
    ["internal", "Internal"],
    ["unknown", "Public"],
  ])("renders %s visibility as %s", (visibility, label) => {
    render(<RepositoryVisibilityBadge visibility={visibility} />);

    expect(screen.getByText(label)).toBeTruthy();
    expect(document.body.textContent).not.toContain("🔒");
    expect(document.body.textContent).not.toContain("◎");
  });
});
