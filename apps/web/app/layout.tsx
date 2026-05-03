import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReviewRouter",
  description: "AI review control plane for GitHub pull requests.",
  icons: [{ rel: "icon", url: "/icon.svg", type: "image/svg+xml" }],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
