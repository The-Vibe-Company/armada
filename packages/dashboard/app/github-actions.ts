"use server";

// Linking and unlinking installations of the Armada GitHub App (THE-851), as
// server actions. Owners and admins link an installation to their
// organization only when GitHub lists it among those they can reach, asked
// with their own GitHub sign-in: nobody links an installation they cannot
// see. Every change is recorded in the Keys page's audit list. The action
// answers with a redirect to the GitHub page, with its outcome in the query.
// The Install button links without this action (THE-852): see
// `lib/github-install.ts`; both go through `linkForViewer`.
import { redirect } from "next/navigation";
import { requireAccounts, requireMember, viewerGithubToken } from "@/lib/accounts-server";
import { transaction } from "@/lib/db";
import { unlinkInstallation } from "@/lib/github-app";
import {
  type GithubResult,
  linkForViewer,
  linkViewerOf,
  managesOrganization,
  githubPage as page,
} from "@/lib/github-install";
import { githubApp } from "@/lib/server";
import { recordEvent } from "@/lib/vault";

export async function linkGithubInstallation(form: FormData): Promise<void> {
  const viewer = await requireMember();
  if (!githubApp()) redirect(page({ error: "off" }));
  const { client } = await requireAccounts();
  const result = await linkForViewer(client, Number(form.get("installation")), {
    viewer: linkViewerOf(viewer),
    githubToken: viewerGithubToken,
    fetch: globalThis.fetch,
    now: new Date(),
  });
  redirect(page(result));
}

export async function unlinkGithubInstallation(form: FormData): Promise<void> {
  const viewer = await requireMember();
  if (!managesOrganization(viewer.organization)) redirect(page({ error: "forbidden" }));
  const installation = Number(form.get("installation"));
  if (!Number.isSafeInteger(installation) || installation <= 0) redirect(page({ error: "unreachable" }));
  const actor = { kind: "person" as const, id: viewer.user.id, label: viewer.signature };
  const { client } = await requireAccounts();
  let result: GithubResult;
  try {
    // Scoped to the viewer's organization: another one's link is left alone.
    await transaction(client, async (tx) => {
      if (!(await unlinkInstallation(tx, viewer.organization.id, installation))) return;
      await recordEvent(tx, viewer.organization.id, {
        at: new Date().toISOString(),
        action: "unlink",
        keys: ["github-app"],
        actor,
        detail: `installation ${installation}`,
      });
    });
    result = { done: "unlinked" };
  } catch (err) {
    console.error(
      `armada dashboard: installation ${installation} not unlinked: ${err instanceof Error ? err.message : String(err)}`,
    );
    result = { error: "failed" };
  }
  redirect(page(result));
}
