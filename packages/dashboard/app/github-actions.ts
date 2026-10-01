"use server";

// Linking and unlinking installations of the Armada GitHub App (THE-851), as
// server actions. Owners and admins link an installation to their
// organization only when GitHub lists it among those they can reach, asked
// with their own GitHub sign-in: nobody links an installation they cannot
// see. Every change is recorded in the Keys page's audit list. The action
// answers with a redirect to the GitHub page, with its outcome in the query.
import { redirect } from "next/navigation";
import { requireAccounts, requireMember, viewerGithubToken } from "@/lib/accounts-server";
import { GITHUB_PATH } from "@/lib/accounts-settings";
import { transaction } from "@/lib/db";
import { linkInstallation, unlinkInstallation, userInstallations } from "@/lib/github-app";
import type { GithubError, GithubNotice } from "@/lib/i18n";
import { githubApp } from "@/lib/server";
import { recordEvent } from "@/lib/vault";

const page = (result: { done: GithubNotice } | { error: GithubError }) =>
  "done" in result ? `${GITHUB_PATH}?done=${result.done}` : `${GITHUB_PATH}?error=${result.error}`;

/** The viewer, who must manage the organization, and the installation the form names. */
async function target(form: FormData) {
  const viewer = await requireMember();
  if (viewer.organization.role !== "owner" && viewer.organization.role !== "admin")
    redirect(page({ error: "forbidden" }));
  const id = Number(form.get("installation"));
  if (!Number.isSafeInteger(id) || id <= 0) redirect(page({ error: "unreachable" }));
  return { viewer, installation: id, actor: { kind: "person" as const, id: viewer.user.id, label: viewer.signature } };
}

export async function linkGithubInstallation(form: FormData): Promise<void> {
  const { viewer, installation, actor } = await target(form);
  if (!githubApp()) redirect(page({ error: "off" }));
  const token = await viewerGithubToken();
  if (!token) redirect(page({ error: "no-github" }));
  const { client } = await requireAccounts();
  let result: Parameters<typeof page>[0];
  try {
    const reachable = await userInstallations(globalThis.fetch, token);
    const now = new Date();
    const linked = await transaction(client, async (tx) => {
      const outcome = await linkInstallation(tx, {
        organization: viewer.organization.id,
        installation,
        reachable,
        by: { id: viewer.user.id, label: viewer.signature },
        now,
      });
      if (outcome !== "linked") return false;
      const account = reachable.find((i) => i.id === installation)?.account ?? String(installation);
      await recordEvent(tx, viewer.organization.id, {
        at: now.toISOString(),
        action: "link",
        keys: ["github-app"],
        actor,
        detail: `installation ${installation} on ${account}`,
      });
      return true;
    });
    result = linked ? { done: "linked" } : { error: "unreachable" };
  } catch (err) {
    console.error(
      `armada dashboard: installation ${installation} not linked: ${err instanceof Error ? err.message : String(err)}`,
    );
    result = { error: "failed" };
  }
  redirect(page(result));
}

export async function unlinkGithubInstallation(form: FormData): Promise<void> {
  const { viewer, installation, actor } = await target(form);
  const { client } = await requireAccounts();
  let result: Parameters<typeof page>[0];
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
