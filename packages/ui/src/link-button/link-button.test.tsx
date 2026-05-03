// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LinkButton } from "./link-button";

describe("LinkButton", () => {
  it("renders an accessible link styled as a button", () => {
    render(<LinkButton href="/getting-started">Getting started</LinkButton>);

    const link = screen.getByRole("link", { name: "Getting started" });
    expect(link).toHaveProperty(
      "href",
      "http://localhost:3000/getting-started",
    );
  });
});
