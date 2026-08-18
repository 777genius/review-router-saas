import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const layoutSource = readFileSync(
  new URL("./layout.tsx", import.meta.url),
  "utf8",
);

describe("web font loading contract", () => {
  it("uses only local Next.js fonts at build time", () => {
    expect(layoutSource).toContain('import localFont from "next/font/local"');
    expect(layoutSource).not.toContain("next/font/google");
    expect(layoutSource).not.toContain("fonts.googleapis.com");
    expect(layoutSource).not.toContain("fonts.gstatic.com");
  });

  it.each([
    ["space-grotesk-latin-variable.woff2", "--font-sans"],
    ["jetbrains-mono-latin-variable.woff2", "--font-mono"],
  ])("self-hosts %s and preserves %s", (fileName, cssVariable) => {
    const font = readFileSync(new URL(`./fonts/${fileName}`, import.meta.url));

    expect(font.subarray(0, 4).toString("ascii")).toBe("wOF2");
    expect(font.byteLength).toBeGreaterThan(10_000);
    expect(layoutSource).toContain(`src: "./fonts/${fileName}"`);
    expect(layoutSource).toContain(`variable: "${cssVariable}"`);
  });
});
