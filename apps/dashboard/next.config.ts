import type { NextConfig } from "next";

const config: NextConfig = {
  // @armada/core ships TypeScript source, which Next compiles with the app.
  transpilePackages: ["@armada/core"],
  reactStrictMode: true,
  poweredByHeader: false,
  // Pages renamed for what they hold: the Build pages (#808) and Credentials, now Harness (#805). Old links, bookmarks
  // and the OAuth return keep working, query included (Next carries it over).
  async redirects() {
    return [
      { source: "/goldens", destination: "/environments", permanent: false },
      { source: "/connections", destination: "/tools", permanent: false },
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
