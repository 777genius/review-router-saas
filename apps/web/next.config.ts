import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  serverExternalPackages: ["@777genius/subscription-runtime"],
  transpilePackages: ["@reviewrouter/ui"],
};

export default nextConfig;
