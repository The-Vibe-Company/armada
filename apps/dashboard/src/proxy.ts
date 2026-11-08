import { CLIENT_CONFIG_PATH } from "@armada/core";
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { supabaseEnv } from "@/lib/env";
import { isPublicPath } from "@/lib/routes";
import type { Database } from "@/lib/supabase/types";

/** Refreshes the session cookie on every request and sends signed-out visitors to the login page. */
export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === CLIENT_CONFIG_PATH) return NextResponse.next();
  const { url, anonKey } = supabaseEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list) {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const { pathname, search } = request.nextUrl;

  const redirect = (target: URL) => {
    const redirected = NextResponse.redirect(target);
    for (const cookie of response.cookies.getAll()) redirected.cookies.set(cookie);
    return redirected;
  };

  if (!signedIn && pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  }
  if (!signedIn && !isPublicPath(pathname)) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
    return redirect(login);
  }
  if (signedIn && pathname === "/login") {
    const home = request.nextUrl.clone();
    home.pathname = "/";
    home.search = "";
    return redirect(home);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
