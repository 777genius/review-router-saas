import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  transpilePackages: ["@reviewrouter/ui"],
};

export default nextConfig;
