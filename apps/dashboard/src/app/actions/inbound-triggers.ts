"use server";

import { revalidatePath } from "next/cache";
import { isUuid } from "@/lib/action";
import { ControlError } from "@/lib/control";
import { viewerInboundTriggers } from "@/lib/data/inbound-triggers";

export async function triggerDeliveries(org: string, id: string) {
  const control = isUuid(id) ? await viewerInboundTriggers(org) : null;
  if (!control) return { ok: false } as const;
  try {
    return { ok: true, deliveries: await control.deliveries(id) } as const;
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return { ok: false } as const;
  }
}

export async function manageInboundTrigger(org: string, id: string, action: "rotate" | "disable") {
  if (action !== "rotate" && action !== "disable") return { error: "Choose a trigger action." };
  const control = isUuid(id) ? await viewerInboundTriggers(org) : null;
  if (!control) return { error: "Select the organization where you are an admin." };
  try {
    if (action === "rotate") return { signingSecret: await control.rotate(id) };
    await control.disable(id);
    revalidatePath("/triggers");
    return {};
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return {
      error:
        action === "rotate"
          ? "Could not confirm the new key. Reload the trigger, then rotate again to get a usable key."
          : "Could not confirm that the trigger was disabled. Reload to check its status.",
    };
  }
}
