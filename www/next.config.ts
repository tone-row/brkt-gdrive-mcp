import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-protected-resource/:path*",
        destination: "/api/oauth/resource-metadata/:path*",
      },
    ];
  },
};

export default nextConfig;
