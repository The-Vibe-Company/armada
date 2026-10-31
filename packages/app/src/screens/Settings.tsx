import { Blocks, Bot, Info, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { DaemonProblem } from "@/components/DaemonProblem";
import { Dot, Page, PageHeader } from "@/components/page";
import { CONNECTIONS, type Connection, type SettingsSection } from "@/lib/route";
import { NotificationSetting } from "@/notify/NotificationSetting";
import { About } from "@/settings/About";
import { Connections, ConnectionsFacts } from "@/settings/Connections";
import { Coordinator } from "@/settings/Coordinator";
import { Mark } from "@/settings/marks";
import { type NavGroup, SettingsBreadcrumb, SettingsFrame, SettingsNav } from "@/settings/Nav";
import { Providers, ProvidersFacts, useProvidersQuiet } from "@/settings/Providers";

/** A lucide icon at the nav's stroke, decorative: the row's label names it. */
const icon = (Icon: LucideIcon) => (props: { className?: string }) => (
  <Icon aria-hidden strokeWidth={1.75} {...props} />
);
const mark = (name: string) => (props: { className?: string }) => <Mark mark={name} {...props} />;

/** The nav's groups (THE-2075, after T3 Code's): Coordinator; Agents; Connections; About. */
const NAV: readonly NavGroup[] = [
  { rows: [{ section: "coordinator", label: "Coordinator", icon: icon(Bot) }] },
  { label: "Agents", rows: [{ section: "providers", label: "Providers", icon: icon(Blocks) }] },
  {
    label: "Connections",
    rows: [
      { section: "connections", detail: "linear", label: "Linear", icon: mark("linear") },
      { section: "connections", detail: "github", label: "GitHub", icon: mark("github") },
      { section: "connections", detail: "armada", label: "Armada", icon: mark("armada") },
    ],
  },
  { rows: [{ section: "about", label: "About", icon: icon(Info) }] },
];

const LABEL: Record<SettingsSection, string> = {
  coordinator: "Coordinator",
  providers: "Providers",
  connections: "Connections",
  about: "About",
};

const QUIET: Record<Exclude<SettingsSection, "providers">, string> = {
  coordinator:
    "The model your coordinators think with, and how Armada tells you a room needs you. Both stay on this device.",
  connections:
    "Where Armada reads tickets and code, and your sign-in to Armada, shared by this app and the CLI on this device.",
  about: "This app, and the daemon it speaks to.",
};

/**
 * The settings (`#/settings/<section>[/<card>]`, reached from the sidebar's
 * bottom; THE-2069 and THE-2075, after T3 Code's): the v7 title line, then the
 * grouped nav beside the chosen section under its breadcrumb.
 */
export function Settings({
  section,
  detail,
  address,
  onReload,
}: {
  section: SettingsSection;
  /** The open card: an agent's id under Providers, linear, github or armada under Connections. */
  detail?: string;
  address: string;
  onReload: () => void;
}) {
  const providersQuiet = useProvidersQuiet();
  const facts: ReactNode =
    section === "providers" ? (
      <ProvidersFacts />
    ) : section === "connections" ? (
      <ConnectionsFacts />
    ) : (
      <>
        <span>Daemon</span>
        <Dot />
        <span className="font-mono">{address}</span>
      </>
    );
  const connection = CONNECTIONS.find((c) => c === detail) as Connection | undefined;
  return (
    <Page>
      <PageHeader facts={facts} title="Settings" quiet={section === "providers" ? providersQuiet : QUIET[section]} />
      <DaemonProblem onReload={onReload} />
      <SettingsFrame nav={<SettingsNav groups={NAV} section={section} detail={detail} />}>
        <SettingsBreadcrumb label={LABEL[section]} />
        {section === "coordinator" ? (
          <>
            <Coordinator />
            {/* THE-2055: the OS notifications' switch. */}
            <NotificationSetting />
          </>
        ) : section === "providers" ? (
          <Providers detail={detail} />
        ) : section === "connections" ? (
          <Connections detail={connection} />
        ) : (
          <About address={address} />
        )}
      </SettingsFrame>
    </Page>
  );
}
