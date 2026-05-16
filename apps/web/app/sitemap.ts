import type { MetadataRoute } from "next";
import { reviewRouterWebUrl } from "./public-urls";

const publicRoutes = [
  { path: "/", priority: 1 },
  { path: "/getting-started", priority: 0.9 },
  { path: "/security", priority: 0.85 },
  { path: "/privacy", priority: 0.8 },
  { path: "/compare", priority: 0.78 },
  { path: "/support", priority: 0.6 },
  { path: "/terms", priority: 0.45 },
  { path: "/fair-use", priority: 0.45 },
  { path: "/disconnect", priority: 0.35 },
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return publicRoutes.map((route) => ({
    url: `${reviewRouterWebUrl}${route.path}`,
    lastModified,
    changeFrequency: route.path === "/" ? "weekly" : "monthly",
    priority: route.priority,
  }));
}
