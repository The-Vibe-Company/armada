import type { Plugin, Provider } from "@armada/protocol";
import { useState } from "react";
import { Dot } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { settingsHref } from "@/lib/route";
import { pluginCounts } from "@/plugins/list";
import { useDaemon, useDaemonClient } from "@/protocol/store";
import { Card, go, useEscapeCloses } from "./Card";
import { useDisplayName } from "./display-names";
import { SettingsRow, SettingsSection } from "./Layout";
import { focusSignInOf, ProviderDetail } from "./ProviderDetail";
import { useSignIn, useSignInFollows } from "./ProviderSignIn";
import { agentCards, agentStatus, versionLabel } from "./provider-view";
import { Restart } from "./RestartNotice";

/**
 * Settings › Providers (THE-2075, after T3 Code's ProviderSettingsPanel): the
 * coding agents the daemon catalogs (`providers.catalog`, `seam: "agent"`),
 * in its order, as cards in one grouped container: mark, name, CLI version,
 * the status line and a switch (`plugins.enable` / `plugins.disable`, applied
 * when the daemon restarts: the notice above says so). The open card's detail
 * is below the list (`#/settings/providers/<id>`); Escape closes it. "Add
 * provider" ends the list: the bundled agents the catalog does not show.
 */
export function Providers({ detail }: { detail?: string }) {
  const { providers, providersProblem, plugins, status } = useDaemon();
  const signIn = useSignIn("provider");
  const agents = agentCards(providers ?? []);
  const open = agents.find((a) => a.id === detail);
  useEscapeCloses(open?.id, () => go(settingsHref("providers")));
  useSignInFollows(signIn, open?.id);
  const pending = plugins
    ? pluginCounts(plugins.plugins).pending
    : (providers ?? []).filter((p) => p.restartRequired).length;
  const live = status === "live";
  return (
    <>
      {providersProblem && (
        <div role="alert" className="rounded-card bg-card px-4 py-3 text-amber shadow-ring">
          {providersProblem}
        </div>
      )}
      <Restart pending={pending} />
      {providers && (
        <SettingsSection title="Agents" count={agents.length}>
          {agents.length === 0 && <SettingsRow title="No agent" description="This build of Armada ships none." />}
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              provider={agent}
              open={agent.id === open?.id}
              live={live}
              onToggle={() => go(settingsHref("providers", agent.id === open?.id ? undefined : agent.id))}
            />
          ))}
          <AddProvider agents={agents} plugins={plugins?.plugins ?? null} live={live} />
        </SettingsSection>
      )}
      {open && <ProviderDetail key={open.id} provider={open} signIn={signIn} />}
    </>
  );
}

function AgentCard({
  provider,
  open,
  live,
  onToggle,
}: {
  provider: Provider;
  open: boolean;
  live: boolean;
  onToggle: () => void;
}) {
  const client = useDaemonClient();
  const name = useDisplayName(provider.mark, provider.name);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const status = agentStatus(provider);
  async function flip(enabled: boolean) {
    setSaving(true);
    setProblem(null);
    try {
      await client.setPluginEnabled(provider.mark, enabled);
      // Turned on and not signed in: its detail opens on Sign in.
      if (enabled && provider.state === "disconnected") {
        focusSignInOf(provider.id);
        go(settingsHref("providers", provider.id));
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The switch was not saved.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="flex flex-col">
      <Card
        id={provider.id}
        mark={provider.mark}
        name={name}
        version={versionLabel(provider.version)}
        status={provider.restartRequired ? { ...status, detail: "Restart to apply" } : status}
        open={open}
        dim={!provider.enabled}
        onToggle={onToggle}
        control={
          <Switch
            aria-label={`Enable ${name}`}
            checked={provider.enabled}
            disabled={saving || !live}
            onCheckedChange={(checked) => void flip(checked)}
          />
        }
      />
      {problem && (
        <p role="alert" className="m-0 px-4 pb-3 text-small text-red">
          {problem}
        </p>
      )}
    </div>
  );
}

/** The bundled agents the catalog does not list, to turn on; none today, so the button waits disabled. */
function AddProvider({
  agents,
  plugins,
  live,
}: {
  agents: readonly Provider[];
  plugins: readonly Plugin[] | null;
  live: boolean;
}) {
  const client = useDaemonClient();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const missing = (plugins ?? []).filter(
    (p) => p.contributions.some((c) => c.seam === "runtime") && !agents.some((a) => a.mark === p.id),
  );
  return (
    <div data-add-provider className="flex flex-col gap-2 px-4 py-2.5">
      <Button
        variant="ghost"
        aria-expanded={open}
        disabled={missing.length === 0}
        title={missing.length === 0 ? "Every agent bundled with Armada is listed" : undefined}
        onClick={() => setOpen(!open)}
        className="-mx-2 w-fit px-2"
      >
        + Add provider
      </Button>
      {open && missing.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {missing.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3">
              <span className="text-body">{p.id}</span>
              <Button
                variant="soft"
                disabled={!live || p.enabled}
                onClick={() =>
                  void client.setPluginEnabled(p.id, true).catch((error: unknown) => {
                    setProblem(error instanceof Error ? error.message : "The agent was not turned on.");
                  })
                }
              >
                {p.enabled ? "On" : "Turn on"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p role="alert" className="m-0 text-small text-red">
          {problem}
        </p>
      )}
    </div>
  );
}

/** The facts line: how many agents, how many signed in. */
export function ProvidersFacts() {
  const { providers } = useDaemon();
  if (!providers) return <span>Providers</span>;
  const agents = agentCards(providers);
  const signedIn = agents.filter((a) => a.state === "connected").length;
  return (
    <>
      <span>
        {agents.length} {agents.length === 1 ? "agent" : "agents"}
      </span>
      <Dot />
      <span>{signedIn} signed in</span>
    </>
  );
}

/** The quiet line: what a switch does, or why the list is not there yet. */
export function useProvidersQuiet(): string | null {
  const { providers, providersProblem, status } = useDaemon();
  if (providers) return "The coding agents your workers run. A switch applies when the daemon restarts.";
  // A problem says itself above the list (or above the page, the daemon's own).
  return providersProblem || status === "refused" ? null : "Waiting for the daemon to list its providers.";
}
