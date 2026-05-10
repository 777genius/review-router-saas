import type { MetadataRoute } from "next";
import { reviewRouterWebUrl } from "./public-urls";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/auth/", "/dashboard/"],
      },
    ],
    sitemap: `${reviewRouterWebUrl}/sitemap.xml`,
  };
}
