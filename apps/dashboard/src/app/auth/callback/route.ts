import type { EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { originFromHeaders, safeNextPath } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";

const OTP_TYPES: readonly EmailOtpType[] = ["email", "magiclink", "signup", "invite", "recovery", "email_change"];

/** Where Supabase sends the person back: after the magic link, or after GitHub / Google. */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const origin = originFromHeaders(request.headers, request.url);
  const next = safeNextPath(searchParams.get("next"));
  const failed = NextResponse.redirect(new URL("/login?error=callback", origin));

  const supabase = await createClient();
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = OTP_TYPES.find((candidate) => candidate === searchParams.get("type"));

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    return error ? failed : NextResponse.redirect(new URL(next, origin));
  }
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    return error ? failed : NextResponse.redirect(new URL(next, origin));
  }
  return failed;
}
