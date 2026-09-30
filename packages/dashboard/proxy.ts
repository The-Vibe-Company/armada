// The password gate in front of the whole dashboard (Next.js "proxy", formerly
// middleware). Every page, route and server action goes through it; only the
// build's static files and the icon do not, since they carry no fleet data.
import type { NextRequest } from "next/server";
import { guard } from "@/lib/auth-http";

export function proxy(request: NextRequest) {
  return guard(request, { env: process.env, now: Date.now() });
}

export const config = {
  // _next/webpack-hmr is the development-only hot reload socket.
  matcher: ["/((?!_next/static/|_next/image|_next/webpack-hmr|icon\\.svg$|favicon\\.ico$).*)"],
};
