import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { removeOwnerNotifications, saveOwnerNotifications, sendOwnerNotificationTest } from "@/app/notify-actions";
import { OrgBar, OrgHeading, OrgNone, OrgPage, OrgRow, OrgRows } from "@/components/org";
import { Button, Form, Input, Notice, Select } from "@/components/page";
import { requireFleetAccess } from "@/lib/access";
import { requireAccounts } from "@/lib/accounts-server";
import { ORGANIZATION_PATH } from "@/lib/accounts-settings";
import { ZONE_COOKIE, zoneOf } from "@/lib/activity-view";
import { DEFAULT_DIGEST } from "@/lib/digest-slots";
import { projectsOf } from "@/lib/fleet-store";
import {
  isLanguage,
  LANGUAGE_COOKIE,
  NOTIFICATIONS_ERRORS,
  NOTIFICATIONS_NOTICES,
  type NotificationsError,
  type NotificationsNotice,
  STRINGS,
} from "@/lib/i18n";
import { listOwnerChannels, type OwnerChannel } from "@/lib/owner-push";
import { languageOf } from "@/lib/server";
import { dbSnapshots, memorySnapshots } from "@/lib/snapshots";
import { vaultModeOf } from "@/lib/vault";

// The organization's owner notification channel (THE-1097): one write-only
// Slack or JSON endpoint, scoped to this organization. Cron remains off by
// default; the owner sees what is configured and the last delivery without
// ever receiving the URL or signing secret back from the server.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.notifications.nav} — Armada` };
}

type Params = Promise<{ error?: string | string[]; done?: string | string[] }>;

const pick = <T extends string>(list: readonly T[], value: string | string[] | undefined): T | null =>
  typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : null;

function trackerLanguage(
  projects: Awaited<ReturnType<typeof projectsOf>>,
  entries: Awaited<ReturnType<ReturnType<typeof dbSnapshots>["entries"]>>,
) {
  for (const project of projects) {
    const raw = entries.get(project.slug)?.snapshot?.config.tracker.language?.trim().toLowerCase();
    const language = raw?.slice(0, 2);
    if (isLanguage(language)) return language;
  }
  return "en" as const;
}

function dateFor(language: "en" | "fr", zone: string) {
  return new Intl.DateTimeFormat(language === "fr" ? "fr-FR" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  });
}

export default async function Notifications({ searchParams }: { searchParams: Params }) {
  const access = await requireFleetAccess();
  if (access.kind !== "account") redirect("/");
  const viewer = access.viewer;
  if (viewer.organization.role !== "owner" && viewer.organization.role !== "admin")
    redirect(`${ORGANIZATION_PATH}?error=forbidden`);

  const [{ client }, jar, params] = await Promise.all([requireAccounts(), cookies(), searchParams]);
  const lang = languageOf(jar.get(LANGUAGE_COOKIE)?.value);
  const t = STRINGS[lang];
  const n = t.notifications;
  const error = pick<NotificationsError>(NOTIFICATIONS_ERRORS, params.error);
  const done = pick<NotificationsNotice>(NOTIFICATIONS_NOTICES, params.done);
  const zone = zoneOf(jar.get(ZONE_COOKIE)?.value);
  const [channels, projects] = await Promise.all([
    listOwnerChannels(client, viewer.organization.id),
    projectsOf(client, viewer.organization.id),
  ]);
  const entries = await dbSnapshots(client, memorySnapshots()).entries(projects.map((project) => project.slug));
  const channel: OwnerChannel | null = channels[0] ?? null;
  const language = channel?.language ?? trackerLanguage(projects, entries);
  const format = channel?.format ?? "slack";
  const date = dateFor(lang, zone);
  const when = (value: string) => date.format(new Date(value));
  const delivery = channel?.last
    ? channel.last.error === "quiet"
      ? n.quietStored
      : channel.last.sentAt
        ? n.lastDelivery(when(channel.last.sentAt))
        : channel.last.at
          ? n.failed(when(channel.last.at))
          : n.neverDelivered
    : n.neverDelivered;
  const reason = channel?.pausedReason;
  const state = reason
    ? n.paused(n.pauseReasons[reason as keyof typeof n.pauseReasons] ?? n.errors.failed)
    : channel?.alerts === false
      ? n.disabled
      : n.active;
  if (vaultModeOf(process.env).kind !== "on")
    return (
      <OrgPage t={t} name={viewer.organization.name} page="notifications">
        <Notice tone="neutral">{n.vaultOff}</Notice>
      </OrgPage>
    );

  return (
    <OrgPage t={t} name={viewer.organization.name} page="notifications">
      {error && <Notice tone="critical">{n.errors[error]}</Notice>}
      {done && <Notice tone="done">{n.notices[done]}</Notice>}
      <OrgBar hint={n.lead}>
        {channel && (
          <>
            <Form action={sendOwnerNotificationTest}>
              <Button tone="primary">{n.sendTest}</Button>
            </Form>
            <Form action={removeOwnerNotifications}>
              <Button tone="danger">{n.remove}</Button>
            </Form>
          </>
        )}
      </OrgBar>

      <OrgHeading>{n.channel}</OrgHeading>
      <OrgRows>
        {channel ? (
          <OrgRow
            a={channel.format === "slack" ? n.slack : n.json}
            sub={n.setBy(channel.createdBy, when(channel.createdAt))}
            b={delivery}
            c={state}
            color={channel.pausedReason || channel.alerts === false ? "var(--amber)" : "var(--green)"}
            d={channel.last?.attempts ? <span className="org-when">{n.attempts(channel.last.attempts)}</span> : null}
          />
        ) : (
          <OrgNone>{n.none}</OrgNone>
        )}
      </OrgRows>

      <OrgHeading>{channel ? t.org.manage : n.save}</OrgHeading>
      <OrgBar hint={n.cron} />
      <details className="org-disclose owner-channel-settings">
        <summary className="btn is-primary">{channel ? t.org.manage : n.save}</summary>
        <div className="org-panel owner-channel-panel">
          <Form action={saveOwnerNotifications} className="owner-channel-form">
            <label htmlFor="owner-channel-url">{n.url}</label>
            <Input
              id="owner-channel-url"
              name="url"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={n.url}
              maxLength={8192}
              required={!channel}
            />

            <label htmlFor="owner-channel-format">{n.format}</label>
            <Select id="owner-channel-format" name="format" defaultValue={format}>
              <option value="slack">{n.slack}</option>
              <option value="json">{n.json}</option>
            </Select>

            <label htmlFor="owner-channel-secret">{n.signingSecret}</label>
            <Input
              id="owner-channel-secret"
              name="signingSecret"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={n.signingSecret}
              maxLength={4096}
            />

            <label htmlFor="owner-channel-project">{n.project}</label>
            <Select id="owner-channel-project" name="project" defaultValue={channel?.project ?? ""}>
              <option value="">{n.allProjects}</option>
              {projects.map((project) => (
                <option key={project.slug} value={project.slug}>
                  {project.name}
                </option>
              ))}
            </Select>

            <label htmlFor="owner-channel-language">{n.language}</label>
            <Select id="owner-channel-language" name="language" defaultValue={language}>
              <option value="en">{n.languages.en}</option>
              <option value="fr">{n.languages.fr}</option>
            </Select>

            <label htmlFor="owner-channel-timezone">{n.timezone}</label>
            <Input
              id="owner-channel-timezone"
              name="timeZone"
              type="text"
              defaultValue={channel?.timeZone ?? zone}
              placeholder={n.timezone}
              maxLength={64}
              spellCheck={false}
            />

            <label htmlFor="owner-channel-quiet-from">{`${n.quiet} · ${n.from}`}</label>
            <Input
              id="owner-channel-quiet-from"
              name="quietFrom"
              type="time"
              defaultValue={channel?.quiet?.from ?? ""}
              aria-label={`${n.quiet} · ${n.from}`}
            />
            <label htmlFor="owner-channel-quiet-to">{`${n.quiet} · ${n.to}`}</label>
            <Input
              id="owner-channel-quiet-to"
              name="quietTo"
              type="time"
              defaultValue={channel?.quiet?.to ?? ""}
              aria-label={`${n.quiet} · ${n.to}`}
            />

            <label htmlFor="owner-digest-times">{n.digestTimes}</label>
            <Input
              id="owner-digest-times"
              name="digestTimes"
              type="text"
              defaultValue={(channel?.digest ?? DEFAULT_DIGEST).times.join(", ")}
              maxLength={144}
              placeholder="09:00, 13:00, 18:00"
            />
            <p className="org-note">{n.digestHint}</p>
            <fieldset className="owner-digest-days">
              <legend>{n.digestDays}</legend>
              {n.weekdays.map((day, index) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    name="digestDays"
                    value={index}
                    defaultChecked={(channel?.digest ?? DEFAULT_DIGEST).days.includes(index)}
                  />{" "}
                  {day}
                </label>
              ))}
            </fieldset>
            <label className="owner-digest-toggle">
              <input type="checkbox" name="skipQuiet" defaultChecked={channel?.digest.skipQuiet ?? false} />{" "}
              {n.skipQuiet}
            </label>
            <label>
              <input type="checkbox" name="alerts" defaultChecked={channel?.alerts ?? true} /> {n.alerts}
            </label>
            <Button tone="primary">{n.save}</Button>
          </Form>
          <p className="org-note">{n.urlHint}</p>
          <p className="org-note">{n.signingSecretHint}</p>
          <p className="org-note">{n.timezoneHint}</p>
          <p className="org-note">{n.alertsHint}</p>
        </div>
      </details>
    </OrgPage>
  );
}
