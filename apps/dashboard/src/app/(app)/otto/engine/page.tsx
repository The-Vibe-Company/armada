import type { OttoEngine, OttoEnginePreflight } from "@armada/core";
import { revalidatePath } from "next/cache";
import { PageHeader } from "@/components/page-header";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { ottoRequest } from "@/lib/otto-request";
import { EnginePicker } from "./engine-picker";

type EngineResponse = {
  engine: OttoEngine | null;
  accounts: { id: string; name: string; kind: string; models?: string[]; status: string }[];
  preflight: OttoEnginePreflight | null;
};

async function engineRequest(method: "GET" | "PUT", body?: unknown): Promise<EngineResponse> {
  const [viewer, selected] = await Promise.all([requireViewer(), selectedOrganization()]);
  const server = mcpUrl();
  if (!server || !viewer.token || !selected) throw new Error("Select an organization and configure the Armada server.");
  const { response, body: resultBody } = await ottoRequest({
    serverUrl: server,
    token: viewer.token,
    orgId: selected.org.id,
    path: "engine",
    method,
    ...(body === undefined ? {} : { body }),
  });
  const result = resultBody as EngineResponse;
  if (!response.ok && !result.preflight) throw new Error("Engine settings are unavailable. Try again.");
  return result;
}
export default async function EnginePage() {
  let data: EngineResponse;
  try {
    data = await engineRequest("GET");
  } catch {
    return (
      <>
        <PageHeader title="Otto engine" description="Choose an engine without launching an attempt." />
        <p>Engine settings are unavailable. Select an organization or try again later.</p>
      </>
    );
  }
  async function save(engine: unknown) {
    "use server";
    try {
      const result = await engineRequest("PUT", engine);
      revalidatePath("/otto/engine");
      return (
        result.preflight ?? {
          ready: false as const,
          error: "account_unavailable" as const,
          message: "The server did not confirm access.",
        }
      );
    } catch {
      return {
        ready: false as const,
        error: "account_unavailable" as const,
        message: "Engine settings could not be saved. Try again.",
      };
    }
  }
  return (
    <>
      <PageHeader
        title="Otto engine"
        description="Your engine for this organization. Saving checks access locally; it never launches an attempt or contacts the model provider."
      />
      <EnginePicker initial={data.engine} accounts={data.accounts} preflight={data.preflight} save={save} />
    </>
  );
}
