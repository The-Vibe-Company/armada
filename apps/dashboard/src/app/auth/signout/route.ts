import { type NextRequest, NextResponse } from "next/server";
import { originFromHeaders } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", originFromHeaders(request.headers, request.url)), 303);
}
