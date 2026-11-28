import "server-only";

import { controlResource } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import {
  type LangfuseInput,
  type LangfuseModelOverrideInput,
  parseLangfuseModelSaveResult,
  parseLangfuseModelsSummary,
  parseLangfuseModelsSyncResult,
  parseLangfuseSettings,
  parseLangfuseTest,
} from "@/lib/langfuse";
import { requireViewer } from "./viewer";

export async function viewerLangfuse(org: string) {
  const { token } = await requireViewer();
  const serverUrl = mcpUrl();
  if (!serverUrl || !token) return null;
  const options = { serverUrl, token };
  const path = `/api/v1/orgs/${org}/langfuse`;
  return {
    read: async (admin: boolean) => parseLangfuseSettings(await controlResource(options, path, "GET"), admin),
    save: (input: LangfuseInput) => controlResource(options, path, "PUT", input),
    disconnect: () => controlResource(options, path, "DELETE"),
    test: async (input: LangfuseInput) =>
      parseLangfuseTest(await controlResource(options, `${path}/test`, "POST", input)),
    models: async () => parseLangfuseModelsSummary(await controlResource(options, `${path}/models`, "GET")),
    syncModels: async () =>
      parseLangfuseModelsSyncResult(await controlResource(options, `${path}/models/sync`, "POST")),
    saveModelOverride: async (input: LangfuseModelOverrideInput) =>
      parseLangfuseModelSaveResult(await controlResource(options, `${path}/models`, "PUT", input)),
    deleteModelOverride: (id: string) => controlResource(options, `${path}/models/${encodeURIComponent(id)}`, "DELETE"),
  };
}
