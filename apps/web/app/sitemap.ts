import type { MetadataRoute } from "next";
import { reviewRouterWebUrl } from "./public-urls";

const publicRoutes = [
  { path: "/", priority: 1, lastModified: "2026-05-29" },
  { path: "/getting-started", priority: 0.9, lastModified: "2026-05-27" },
  { path: "/security", priority: 0.85, lastModified: "2026-05-27" },
  { path: "/privacy", priority: 0.8, lastModified: "2026-05-16" },
  { path: "/compare", priority: 0.78, lastModified: "2026-05-29" },
  { path: "/support", priority: 0.6, lastModified: "2026-05-10" },
  { path: "/terms", priority: 0.45, lastModified: "2026-05-10" },
  { path: "/fair-use", priority: 0.45, lastModified: "2026-05-16" },
  { path: "/disconnect", priority: 0.35, lastModified: "2026-05-25" },
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return publicRoutes.map((route) => ({
    url: `${reviewRouterWebUrl}${route.path}`,
    lastModified: new Date(`${route.lastModified}T00:00:00.000Z`),
    changeFrequency: route.path === "/" ? "weekly" : "monthly",
    priority: route.priority,
  }));
}
