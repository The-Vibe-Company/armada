import type { MetadataRoute } from "next";
import { SITE } from "@/components/landing/content";

// Only the landing is public (THE-887): every other page asks for a sign-in.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: ["/$", "/landing"], disallow: "/" }, host: SITE };
}
