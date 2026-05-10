import type { MetadataRoute } from "next";
import { reviewRouterWebUrl } from "./public-urls";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/install/"],
      },
    ],
    sitemap: `${reviewRouterWebUrl}/sitemap.xml`,
  };
}
