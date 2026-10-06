"use server";

// Owner notification channel settings (THE-1097). These actions keep the
// endpoint and signing secret write-only: values are passed to owner-push and
// never echoed in a redirect or written to a log.
import { redirect } from "next/navigation";
import { requireFleetAccess } from "@/lib/access";
import { requireAccounts } from "@/lib/accounts-server";
import { NOTIFICATIONS_PATH } from "@/lib/accounts-settings";
import type { NotificationsError, NotificationsNotice } from "@/lib/i18n";
import { removeOwnerChannel, safeWebhookFetch, saveOwnerChannel, sendOwnerTest } from "@/lib/owner-push";
import { vaultModeOf } from "@/lib/vault";

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

const page = (result: { done: NotificationsNotice } | { error: NotificationsError }) => {
  const query = new URLSearchParams();
  if ("done" in result) query.set("done", result.done);
  else query.set("error", result.error);
  return `${NOTIFICATIONS_PATH}?${query}`;
};

type AccountAccess = Extract<Awaited<ReturnType<typeof requireFleetAccess>>, { kind: "account" }>;

/** Every owner-push action is behind fleet access, then the manager check. */
async function managerAfter(access: Awaited<ReturnType<typeof requireFleetAccess>>) {
  if (access.kind !== "account") redirect("/");
  if (access.viewer.organization.role !== "owner" && access.viewer.organization.role !== "admin")
    redirect("/organization?error=forbidden");
  return access as AccountAccess;
}

/** Backend validation errors are safe to classify, but their text never reaches the browser. */
const resultFor = (error: unknown): { error: NotificationsError } => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : error instanceof Error
        ? error.message.split(":", 1)[0]
        : null;
  return typeof code === "string" && code.startsWith("invalid")
    ? { error: "invalid" }
    : code === "forbidden"
      ? { error: "forbidden" }
      : { error: "failed" };
};

function vaultOrFail() {
  const vault = vaultModeOf(process.env);
  if (vault.kind !== "on") redirect(page({ error: "failed" }));
  return vault.key;
}

export async function saveOwnerNotifications(form: FormData): Promise<void> {
  const access = await requireFleetAccess();
  const { viewer } = await managerAfter(access);
  const { client } = await requireAccounts();
  const formatValue = text(form, "format");
  const languageValue = text(form, "language");
  if ((formatValue !== "slack" && formatValue !== "json") || (languageValue !== "en" && languageValue !== "fr"))
    redirect(page({ error: "invalid" }));

  const quietFrom = text(form, "quietFrom");
  const quietTo = text(form, "quietTo");
  const quiet = quietFrom || quietTo ? { from: quietFrom, to: quietTo } : null;
  const vault = vaultOrFail();
  try {
    await saveOwnerChannel(client, {
      organization: viewer.organization.id,
      project: text(form, "project") || null,
      format: formatValue,
      alerts: form.get("alerts") === "on",
      timeZone: text(form, "timeZone"),
      language: languageValue,
      quiet,
      url: text(form, "url"),
      signingSecret: text(form, "signingSecret"),
      actor: { kind: "person", id: viewer.user.id, label: viewer.signature },
      now: new Date(),
      vault,
    });
  } catch (error) {
    redirect(page(resultFor(error)));
  }
  redirect(page({ done: "saved" }));
}

export async function sendOwnerNotificationTest(): Promise<void> {
  const access = await requireFleetAccess();
  const { viewer } = await managerAfter(access);
  const { client, settings } = await requireAccounts();
  const vault = vaultOrFail();
  let delivered = false;
  try {
    delivered = await sendOwnerTest(client, {
      organization: viewer.organization.id,
      now: () => new Date(),
      fetch: safeWebhookFetch,
      vault,
      baseUrl: settings.baseUrl,
    });
  } catch {
    redirect(page({ error: "failed" }));
  }
  redirect(page(delivered ? { done: "sent" } : { error: "failed" }));
}

export async function removeOwnerNotifications(): Promise<void> {
  const access = await requireFleetAccess();
  const { viewer } = await managerAfter(access);
  const { client } = await requireAccounts();
  try {
    await removeOwnerChannel(client, {
      organization: viewer.organization.id,
      actor: { kind: "person", id: viewer.user.id, label: viewer.signature },
      now: new Date(),
    });
  } catch (error) {
    redirect(page(resultFor(error)));
  }
  redirect(page({ done: "removed" }));
}
