import { type NextRequest, NextResponse } from "next/server";
import { INVITATION_ACCEPT_PATH, INVITATION_COOKIE } from "@/lib/invitations";
import { originFromHeaders } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const login = new URL("/login", originFromHeaders(request.headers, request.url));
  // "Use another account" on an invitation: back to it after signing in. No other target is accepted here.
  const form = await request.formData().catch(() => null);
  const switching = form?.get("next") === INVITATION_ACCEPT_PATH;
  if (switching) login.searchParams.set("next", INVITATION_ACCEPT_PATH);
  const response = NextResponse.redirect(login, 303);
  // A plain sign-out forgets a pending invitation link, so the next person on this browser does not inherit it.
  if (!switching) response.cookies.delete(INVITATION_COOKIE);
  return response;
}
