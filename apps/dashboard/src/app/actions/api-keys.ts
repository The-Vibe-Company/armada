"use server";

import { controlRouteKey, tokenOperations } from "@armada/core/contract";
import { revalidatePath } from "next/cache";
import { ControlError, createControlClient } from "@/lib/control";
import { readViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";

export async function createApiKey(form: FormData) {
  const op = tokenOperations.createServiceToken;
  const input = op.input.body.safeParse({
    label: form.get("name"),
    org: form.get("org"),
    expires: form.get("expires"),
  });
  if (!input.success) return { ok: false as const, error: "Enter a key name and choose an organization and expiry." };
  const viewer = await readViewer();
  const serverUrl = mcpUrl();
  if (!viewer?.token || !serverUrl) return { ok: false as const, error: "API key management is unavailable." };
  try {
    const client = createControlClient({ serverUrl, token: viewer.token });
    const key = op.output.parse(await client.post(controlRouteKey(op.route), input.data));
    return { ok: true as const, token: key.token, origin: new URL(serverUrl).origin };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof ControlError ? error.message : "Could not create the API key.",
    };
  }
}

export async function revokeApiKey(id: string) {
  const viewer = await readViewer();
  const serverUrl = mcpUrl();
  if (!viewer?.token || !serverUrl) return { ok: false as const, error: "API key management is unavailable." };
  try {
    const op = tokenOperations.revokeServiceToken;
    const input = op.input.body.parse({ id });
    const client = createControlClient({ serverUrl, token: viewer.token });
    op.output.parse(await client.post(controlRouteKey(op.route), input));
    revalidatePath("/settings/api-keys");
    return { ok: true as const, message: "API key revoked." };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof ControlError ? error.message : "Could not revoke the API key.",
    };
  }
}
