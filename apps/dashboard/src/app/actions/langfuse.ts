"use server";

import { revalidatePath } from "next/cache";
import { ControlError } from "@/lib/control";
import { viewerLangfuse } from "@/lib/data/langfuse";
import { selectedOrganization } from "@/lib/data/selected-org";
import {
  LANGFUSE_MISSING_FIELDS_ERROR,
  type LangfuseEditable,
  type LangfuseTest,
  readLangfuseForm,
  readLangfuseModelOverrideForm,
} from "@/lib/langfuse";

type Result = { ok: true; test?: LangfuseTest } | { ok: false; error: string };

export async function updateLangfuse(
  org: string,
  change: "connect" | "edit" | "test" | "test-stored" | "enable" | "disable" | "disconnect",
  form?: FormData,
  baseline?: LangfuseEditable,
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
        const parsed = form ? readLangfuseForm(form, change === "connect" ? undefined : baseline) : null;
        if (!parsed) return { ok: false, error: LANGFUSE_MISSING_FIELDS_ERROR };
        if (!parsed.ok) return { ok: false, error: parsed.error };
        const { input } = parsed;
        if (change === "connect" && !input.secretKey) return { ok: false, error: LANGFUSE_MISSING_FIELDS_ERROR };
        if (change === "test") return { ok: true, test: await control.test(input) };
        if (change === "connect") await control.save({ ...input, enabled: true });
        else if (Object.keys(input).length) await control.save(input);
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

type LangfuseCtrl = NonNullable<Awaited<ReturnType<typeof viewerLangfuse>>>;
const MODEL_ERR: Record<number, string> = {
  401: "Sign in again, then retry.",
  403: "Only an organization admin can change this.",
  502: "Langfuse did not accept this request. Check the connection and try again.",
};

async function runModel<T>(org: string, err400: string, work: (c: LangfuseCtrl) => Promise<T>) {
  const selected = await selectedOrganization();
  if (selected?.org.id !== org) return { ok: false as const, error: "Switch to that organization first." };
  if (selected.role !== "admin") return { ok: false as const, error: "Only an organization admin can change this." };
  const control = await viewerLangfuse(org);
  if (!control) return { ok: false as const, error: "Ask an Armada administrator to finish server setup." };
  try {
    return { ok: true as const, data: await work(control) };
  } catch (e) {
    const code = e instanceof ControlError ? e.status : undefined;
    const msg = code === 400 ? err400 : MODEL_ERR[code ?? 0];
    return { ok: false as const, error: msg ?? "Armada could not complete the request. Reload and retry." };
  }
}

export async function loadLangfuseModels(org: string) {
  return runModel(org, "Connect Langfuse with valid keys first.", (c) => c.models());
}
export async function syncLangfuseModels(org: string) {
  return runModel(org, "Connect Langfuse with valid keys first.", (c) => c.syncModels());
}
export async function saveLangfuseModelOverride(org: string, form: FormData) {
  const p = readLangfuseModelOverrideForm(form);
  return p.ok
    ? runModel(org, "Check model name, regex pattern, and USD/1M prices.", (c) => c.saveModelOverride(p.input))
    : p;
}
export async function deleteLangfuseModelOverride(org: string, modelId: string) {
  const id = modelId.trim();
  if (!id) return { ok: false as const, error: "Select a custom model override to delete." };
  const r = await runModel(org, "Could not delete this custom model override.", (c) => c.deleteModelOverride(id));
  return r.ok ? { ok: true as const } : r;
}
