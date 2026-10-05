// The tabs on top of every organization page: Members, Keys, GitHub,
// Workers and owner notifications. A page puts them in its toolbar, with
// what it filters by in the toolbar's end (the Keys page's project).
import { GITHUB_PATH, KEYS_PATH, NOTIFICATIONS_PATH, ORGANIZATION_PATH, WORKERS_PATH } from "@/lib/accounts-settings";
import type { Strings } from "@/lib/i18n";
import { Tabs } from "./ui";

export type OrganizationPage = "members" | "keys" | "github" | "workers" | "notifications";

export function OrganizationTabs({ t, page }: { t: Strings; page: OrganizationPage }) {
  return (
    <Tabs
      label={t.org.nav}
      push
      value={page}
      items={[
        { key: "members" as const, label: t.org.members, href: ORGANIZATION_PATH },
        { key: "keys" as const, label: t.keys.nav, href: KEYS_PATH },
        { key: "github" as const, label: t.github.nav, href: GITHUB_PATH },
        { key: "workers" as const, label: t.workers.nav, href: WORKERS_PATH },
        { key: "notifications" as const, label: t.notifications.nav, href: NOTIFICATIONS_PATH },
      ]}
    />
  );
}
