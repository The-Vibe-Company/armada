import type { NextConfig } from "next";

const config: NextConfig = {
  // @armada/core ships TypeScript source, which Next compiles with the app.
  transpilePackages: ["@armada/core"],
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
