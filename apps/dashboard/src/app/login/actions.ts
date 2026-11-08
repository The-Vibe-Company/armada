"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { formString } from "@/lib/action";
import { enabledProviders, isOAuthProvider } from "@/lib/auth-config";
import { originFromHeaders, safeNextPath } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { step: "email" | "code"; email?: string; error?: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function callbackUrl(origin: string, next: string): string {
  return `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
}

/** Sends the sign-in email: a link and a one-time code, whichever the Supabase template carries. */
export async function sendLoginEmail(_previous: LoginState, data: FormData): Promise<LoginState> {
  const email = formString(data, "email").trim().toLowerCase();
  const next = safeNextPath(formString(data, "next"));
  if (!EMAIL.test(email)) return { step: "email", error: "Enter a valid email address." };

  const origin = originFromHeaders(await headers());
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: callbackUrl(origin, next), shouldCreateUser: true },
  });
  if (error) return { step: "email", error: "We could not send the email. Try again in a minute." };
  return { step: "code", email };
}

export async function verifyLoginCode(_previous: LoginState, data: FormData): Promise<LoginState> {
  const email = formString(data, "email").trim().toLowerCase();
  const token = formString(data, "code").replace(/\s/g, "");
  const next = safeNextPath(formString(data, "next"));
  if (!EMAIL.test(email)) return { step: "email", error: "Enter a valid email address." };
  if (!/^\d{4,10}$/.test(token)) return { step: "code", email, error: "Enter the code from the email." };

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error) return { step: "code", email, error: "That code is wrong or has expired." };
  redirect(next);
}

export async function signInWithProvider(data: FormData): Promise<void> {
  const provider = formString(data, "provider");
  const next = safeNextPath(formString(data, "next"));
  if (!isOAuthProvider(provider) || !enabledProviders(process.env.NEXT_PUBLIC_AUTH_PROVIDERS).includes(provider)) {
    redirect("/login?error=provider");
  }
  const origin = originFromHeaders(await headers());
  const supabase = await createClient();
  const { data: result, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: callbackUrl(origin, next) },
  });
  if (error || !result.url) redirect("/login?error=provider");
  redirect(result.url);
}
