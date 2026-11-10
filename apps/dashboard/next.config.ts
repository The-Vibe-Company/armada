import type { NextConfig } from "next";

const config: NextConfig = {
  // @armada/core ships TypeScript source, which Next compiles with the app.
  transpilePackages: ["@armada/core"],
  reactStrictMode: true,
  poweredByHeader: false,
  // The Credentials page became Harness (#805): old links and bookmarks land on it.
  async redirects() {
    return [
      { source: "/credentials", destination: "/harness", permanent: true },
      { source: "/credentials/:path*", destination: "/harness", permanent: true },
    ];
  },
  experimental: {
    // Going back to a tab seen in the last 30 s reuses it instead of rendering it again; actions revalidate it.
    staleTimes: { dynamic: 30 },
  },
};

export default config;
