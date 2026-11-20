"use server";

import { createHmac } from "node:crypto";
import { deviceConsentMessage, publicAuthOperations } from "@armada/core/contract";
import { redirect } from "next/navigation";
import { mcpUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

const { authDeviceInspect, authDeviceDecide } = publicAuthOperations;

async function deviceRequest(path: string, authorization: string, body: unknown) {
  const origin = mcpUrl();
  if (!origin) return null;
  try {
    const response = await fetch(new URL(path, origin), {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? await response.json() : null;
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
  const data = await deviceRequest(authDeviceInspect.route.path, `Bearer ${session.access_token}`, parsed.data);
  const login = authDeviceInspect.output.safeParse(data);
  return login.success ? login.data : null;
}

export async function decideCliLogin(id: string, userCode: string, userId: string, form: FormData) {
  const decision = form.get("decision");
  const key = process.env.ARMADA_CLI_CONSENT_KEY;
  if (!key || !/^[a-f0-9]{64}$/.test(key) || (decision !== "authorize" && decision !== "deny"))
    redirect("/cli-login?result=unavailable");

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.refreshSession();
  if (session?.user.id !== userId) redirect("/cli-login?result=unavailable");

  const authorization = `Bearer ${session.access_token}`;
  const consent = { id, user_code: userCode, approve: decision === "authorize", issued_at: Date.now() };
  const proof = createHmac("sha256", key)
    .update(deviceConsentMessage(consent, userId, authorization))
    .digest("hex");
  const parsed = authDeviceDecide.input.body.safeParse({ ...consent, proof });
  if (!parsed.success) redirect("/cli-login?result=unavailable");
  const data = await deviceRequest(authDeviceDecide.route.path, authorization, parsed.data);
  const completed = authDeviceDecide.output.safeParse(data);
  redirect(`/cli-login?result=${completed.success ? decision : "unavailable"}`);
}
