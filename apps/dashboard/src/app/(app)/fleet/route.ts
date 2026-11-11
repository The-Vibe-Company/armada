import { type NextRequest, NextResponse } from "next/server";
import { ACK_COOKIE } from "@/lib/sandbox-attention";

/** Old bookmarks still work; carry the browser's existing acknowledgements to the sandbox views. */
export function GET(request: NextRequest) {
  // A relative redirect preserves the browser origin behind reverse proxies and local bind addresses.
  const response = new NextResponse(null, { status: 307, headers: { Location: "/sandboxes" } });
  response.headers.set("Cache-Control", "private, no-store");
  const legacy = request.cookies.get(ACK_COOKIE)?.value;
  if (legacy) {
    response.cookies.set(ACK_COOKIE, legacy, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/sandboxes",
      maxAge: 60 * 60 * 24 * 14,
    });
    // Two same-name cookies with distinct paths: append the expiry rather than replacing the migrated cookie.
    response.headers.append("Set-Cookie", `${ACK_COOKIE}=; Path=/fleet; Max-Age=0; HttpOnly; SameSite=Lax`);
  }
  return response;
}
