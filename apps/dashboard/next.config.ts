import type { NextConfig } from "next";

const config: NextConfig = {
  // @armada/core ships TypeScript source, which Next compiles with the app.
  transpilePackages: ["@armada/core"],
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Going back to a tab seen in the last 30 s reuses it instead of rendering it again; actions revalidate it.
    staleTimes: { dynamic: 30 },
  },
};

export default config;
