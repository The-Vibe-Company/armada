import type { MetadataRoute } from "next";

// The installed dashboard (THE-881): its icons come from `bun run icons` (scripts/icons.ts).
// #09090b is the dashboard's background (`--bg` in globals.css).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Armada",
    short_name: "Armada",
    description: "Armada: the live fleet of every registered project.",
    start_url: "/",
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#09090b",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
