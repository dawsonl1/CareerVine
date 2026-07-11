import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  async rewrites() {
    return {
      // Serve the standalone feature guide on the docs subdomain.
      // Host-scoped, so the main app's routing is untouched.
      beforeFiles: [
        {
          source: "/:path*",
          has: [{ type: "host", value: "docs.careervine.app" }],
          destination: "/docs/index.html",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
