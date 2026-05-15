import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultSeoDescription, siteName } from "./seo";

export const alt = "ReviewRouter privacy-first AI code review in CI";

export const size = {
  width: 1200,
  height: 630,
} as const;

export const contentType = "image/png";

export default async function Image(): Promise<ImageResponse> {
  const logoData = await readFile(
    join(process.cwd(), "public/review-router-icon.png"),
    "base64",
  );
  const logoSrc = `data:image/png;base64,${logoData}`;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#0a0a0f",
        color: "#cffafe",
        padding: 72,
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 24,
          color: "#67e8f9",
          fontSize: 32,
          fontWeight: 700,
          letterSpacing: 0,
        }}
      >
        <div
          style={{
            width: 88,
            height: 88,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 24,
            border: "2px solid rgba(103,232,249,0.55)",
            background: "rgba(255,255,255,0.05)",
            boxShadow: "0 0 32px rgba(0,240,255,0.18)",
            overflow: "hidden",
          }}
        >
          <img
            src={logoSrc}
            alt=""
            width={82}
            height={82}
            style={{
              objectFit: "contain",
            }}
          />
        </div>
        <div>{siteName}</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div
          style={{
            maxWidth: 940,
            color: "#ecfeff",
            fontSize: 78,
            fontWeight: 800,
            lineHeight: 0.98,
            letterSpacing: 0,
          }}
        >
          Free privacy-first AI code review in your CI
        </div>
        <div
          style={{
            maxWidth: 900,
            color: "#94a3b8",
            fontSize: 30,
            lineHeight: 1.35,
            letterSpacing: 0,
          }}
        >
          {defaultSeoDescription}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 18,
          color: "#bef264",
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: 0,
        }}
      >
        <span>Free</span>
        <span>Code stays in CI</span>
        <span>Codex Subscription</span>
        <span>Claude Subscription</span>
        <span>OpenAI</span>
        <span>OpenRouter</span>
      </div>
    </div>,
    size,
  );
}
