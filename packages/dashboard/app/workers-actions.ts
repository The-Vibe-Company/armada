"use server";

// Revoking a worker (THE-841), as a server action: owners and admins end a
// worker's session, or void its launch token while unused. The worker's next
// command is refused and it gets no more keys. The action answers with a
// redirect to the Workers page, with its outcome in the query.
import { redirect } from "next/navigation";
import { requireAccounts, requireMember } from "@/lib/accounts-server";
import { WORKERS_PATH } from "@/lib/accounts-settings";
import type { WorkersError } from "@/lib/i18n";
import { endWorker } from "@/lib/workers";

const page = (result: "revoked" | { error: WorkersError }) =>
  result === "revoked" ? `${WORKERS_PATH}?done=revoked` : `${WORKERS_PATH}?error=${result.error}`;

export async function revokeWorker(form: FormData): Promise<void> {
  const viewer = await requireMember();
  if (viewer.organization.role !== "owner" && viewer.organization.role !== "admin")
    redirect(page({ error: "forbidden" }));
  const id = form.get("id");
  if (typeof id !== "string" || !id) redirect(page({ error: "gone" }));
  const { client } = await requireAccounts();
  let result: Parameters<typeof page>[0];
  try {
    // Scoped to the viewer's organization: an id from another one ends nothing.
    const ended = await endWorker(client, {
      organization: viewer.organization.id,
      id,
      reason: "revoked",
      by: { kind: "person", id: viewer.user.id, label: viewer.signature },
      now: new Date(),
    });
    result = ended ? "revoked" : { error: "gone" };
  } catch (err) {
    console.error(`armada dashboard: worker ${id} not revoked: ${err instanceof Error ? err.message : String(err)}`);
    result = { error: "failed" };
  }
  redirect(page(result));
}
