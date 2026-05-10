import type { MetadataRoute } from "next";
import { defaultSeoDescription, siteName } from "./seo";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: siteName,
    short_name: siteName,
    description: defaultSeoDescription,
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0f",
    theme_color: "#00f0ff",
    icons: [
      {
        src: "/review-router-icon.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
