import { after } from "next/server";
import { requireFleetAccess } from "@/lib/access";
import { accounts } from "@/lib/accounts-server";
import { answerOverview, timed } from "@/lib/live-http";
import { ownerPulse, safeWebhookFetch } from "@/lib/owner-push";
import { getOverview } from "@/lib/server";
import { vaultModeOf } from "@/lib/vault";

export const dynamic = "force-dynamic";

/** The live Fleet overview, polled by the page; 304 while nothing changed. Carries no secret. */
export async function GET(request: Request) {
  const access = await requireFleetAccess();
  return timed("/api/fleet", async () => {
    const overview = await getOverview();
    const vault = vaultModeOf(process.env);
    if (access.kind === "account" && vault.kind === "on")
      after(async () => {
        try {
          const a = await accounts();
          if (!a) return;
          for (const project of overview.projects)
            await ownerPulse(a.client, {
              organization: access.scope.organization,
              project: project.slug,
              now: () => new Date(),
              vault: vault.key,
              fetch: safeWebhookFetch,
              baseUrl: a.settings.baseUrl,
            });
        } catch {
          console.error("armada dashboard: owner alert tick failed");
        }
      });
    return answerOverview(request, overview);
  });
}
