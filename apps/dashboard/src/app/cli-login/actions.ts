"use server";

import { publicAuthOperations } from "@armada/core/contract";
import { redirect } from "next/navigation";
import { mcpUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

const { authDeviceInspect, authDeviceDecide } = publicAuthOperations;

async function deviceRequest(path: string, accessToken: string, body: unknown) {
  const origin = mcpUrl();
  if (!origin) return null;
  try {
    return await fetch(new URL(path, origin), {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
}

export async function inspectCliLogin(id: string) {
  const parsed = authDeviceInspect.input.body.safeParse({ id });
  if (!parsed.success) return null;
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  const response = await deviceRequest(authDeviceInspect.route.path, session.access_token, parsed.data);
  if (!response?.ok) return null;
  const login = authDeviceInspect.output.safeParse(await response.json());
  return login.success ? login.data : null;
}

export async function decideCliLogin(id: string, userCode: string, userId: string, form: FormData) {
  const decision = form.get("decision");
  const parsed = authDeviceDecide.input.body.safeParse({ id, user_code: userCode, approve: decision === "authorize" });
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!parsed.success || (decision !== "authorize" && decision !== "deny") || session?.user.id !== userId)
    redirect("/cli-login?result=unavailable");
  const response = await deviceRequest(authDeviceDecide.route.path, session.access_token, parsed.data);
  redirect(`/cli-login?result=${response?.ok ? decision : "unavailable"}`);
}
