import { Blocks, Bot, CircleUser, Info } from "lucide-react";
import type { ReactNode } from "react";
import { DaemonProblem } from "@/components/DaemonProblem";
import { Dot, Page, PageHeader } from "@/components/page";
import type { SettingsSection } from "@/lib/route";
import { About } from "@/settings/About";
import { Account } from "@/settings/Account";
import { Coordinator } from "@/settings/Coordinator";
import { type NavSection, SettingsFrame } from "@/settings/Layout";
import { Providers, ProvidersFacts, useProvidersQuiet } from "@/settings/Providers";

const SECTIONS: readonly NavSection[] = [
  { section: "coordinator", label: "Coordinator", icon: Bot },
  { section: "providers", label: "Providers", icon: Blocks },
  { section: "account", label: "Account", icon: CircleUser },
  { section: "about", label: "About", icon: Info },
];

const QUIET: Record<Exclude<SettingsSection, "providers">, string> = {
  coordinator: "The model your coordinators think with. Its key stays on this device.",
  account: "Your sign-in to Armada, shared by this app and the CLI on this device.",
  about: "This app, and the daemon it speaks to.",
};

/**
 * The settings (`#/settings/<section>`, reached from the sidebar's bottom;
 * THE-2069, after T3 Code's): the v7 title line, then the nav of sections
 * beside the chosen one.
 */
export function Settings({
  section,
  address,
  onReload,
}: {
  section: SettingsSection;
  address: string;
  onReload: () => void;
}) {
  const providersQuiet = useProvidersQuiet();
  const facts: ReactNode =
    section === "providers" ? (
      <ProvidersFacts />
    ) : (
      <>
        <span>Daemon</span>
        <Dot />
        <span className="font-mono">{address}</span>
      </>
    );
  return (
    <Page>
      <PageHeader facts={facts} title="Settings" quiet={section === "providers" ? providersQuiet : QUIET[section]} />
      <DaemonProblem onReload={onReload} />
      <SettingsFrame sections={SECTIONS} current={section}>
        {section === "coordinator" ? (
          <Coordinator />
        ) : section === "providers" ? (
          <Providers />
        ) : section === "account" ? (
          <Account />
        ) : (
          <About address={address} />
        )}
      </SettingsFrame>
    </Page>
  );
}
