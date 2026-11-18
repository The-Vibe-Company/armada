"use server";

import { revalidatePath } from "next/cache";
import { ControlError } from "@/lib/control";
import { viewerLangfuse } from "@/lib/data/langfuse";
import { selectedOrganization } from "@/lib/data/selected-org";
import { type LangfuseTest, readLangfuseForm } from "@/lib/langfuse";

type Result = { ok: true; test?: LangfuseTest } | { ok: false; error: string };

export async function updateLangfuse(
  org: string,
  change: "connect" | "edit" | "test" | "test-stored" | "enable" | "disable" | "disconnect",
  form?: FormData,
): Promise<Result> {
  const selected = await selectedOrganization();
  if (selected?.org.id !== org) return { ok: false, error: "Switch to that organization first." };
  if (selected.role !== "admin") return { ok: false, error: "Only an organization admin can change this." };
  const control = await viewerLangfuse(org);
  if (!control) return { ok: false, error: "Ask an Armada administrator to finish server setup, then try again." };
  try {
    switch (change) {
      case "connect":
      case "edit":
      case "test": {
        const input = form && readLangfuseForm(form);
        if (!input || (change === "connect" && !input.secretKey)) {
          return { ok: false, error: "Enter the host and keys from your Langfuse project settings." };
        }
        if (change === "test") return { ok: true, test: await control.test(input) };
        await control.save(change === "connect" ? { ...input, enabled: true } : input);
        break;
      }
      case "test-stored":
        return { ok: true, test: await control.test({}) };
      case "enable":
      case "disable":
        await control.save({ enabled: change === "enable" });
        break;
      case "disconnect":
        await control.disconnect();
        break;
      default:
        return { ok: false, error: "Reload this organization and try again." };
    }
    revalidatePath(`/orgs/${org}`);
    return { ok: true };
  } catch (error) {
    if (error instanceof ControlError && error.status === 401) {
      return { ok: false, error: "Sign in again, then retry." };
    }
    if (error instanceof ControlError && error.status === 400 && form) {
      return { ok: false, error: "Check the HTTPS host and keys from your Langfuse project settings, then try again." };
    }
    return { ok: false, error: "Armada could not complete the request. Reload this organization before retrying." };
  }
}
