import { ImageResponse } from "next/og";
import { defaultSeoDescription, siteName } from "./seo";

export const alt = "ReviewRouter privacy-first AI code review in CI";

export const size = {
  width: 1200,
  height: 630,
} as const;

export const contentType = "image/png";

export default function Image(): ImageResponse {
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
            width: 64,
            height: 64,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 18,
            border: "2px solid rgba(103,232,249,0.55)",
            background: "rgba(103,232,249,0.12)",
          }}
        >
          RR
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
          Privacy-first AI code review in your CI
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
          fontSize: 24,
          fontWeight: 700,
          letterSpacing: 0,
        }}
      >
        <span>No code custody</span>
        <span>Codex</span>
        <span>OpenAI</span>
        <span>OpenRouter</span>
      </div>
    </div>,
    size,
  );
}
