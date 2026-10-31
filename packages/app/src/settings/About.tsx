import { PROTOCOL_VERSION } from "@armada/protocol";
import type { ReactNode } from "react";
import { pluginCounts } from "@/plugins/list";
import { useDaemon } from "@/protocol/store";
import { FoldedSection, SettingsRow, SettingsSection, StateDot } from "./Layout";
import { PluginList } from "./Plugins";
import { Restart } from "./RestartNotice";

/** The app's version, from its package.json (vite.config.ts); a test's static render has none. */
const APP_VERSION = typeof __ARMADA_APP_VERSION__ === "string" ? __ARMADA_APP_VERSION__ : null;

/**
 * Settings' About: where the daemon is and which versions speak. The daemon
 * reports only its protocol's minor today; its own version and its data
 * folder say so until the protocol carries them. Advanced, folded (THE-2075):
 * the nodes and the raw plugin list, the only place the word appears.
 */
export function About({ address }: { address: string }) {
  const { minor } = useDaemon();
  const app = `${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}`;
  return (
    <>
      <SettingsSection title="Daemon">
        <SettingsRow
          title="Address"
          description="Where this app reaches the daemon."
          control={<Value>{address}</Value>}
        />
        <SettingsRow title="Version" description="The daemon's own version." control={<Unreported />} />
        <SettingsRow
          title="Data folder"
          description="Where the daemon keeps the fleet's log and its settings."
          control={<Unreported />}
        />
      </SettingsSection>
      <SettingsSection title="Versions">
        <SettingsRow
          title="App"
          description="This app's version."
          control={<Value>{APP_VERSION ?? "Unknown"}</Value>}
        />
        <SettingsRow
          title="Protocol"
          description="The version of the protocol this app speaks, and the minor the daemon answers with."
          control={
            <span className="flex items-baseline gap-2 text-small" data-protocol>
              <Value>{app}</Value>
              <span className="text-text-3">daemon</span>
              <Value>{minor === null ? "…" : `${PROTOCOL_VERSION.major}.${minor}`}</Value>
            </span>
          }
        />
      </SettingsSection>
      <FoldedSection title="Advanced">
        <Advanced />
      </FoldedSection>
    </>
  );
}

/** The node providers (where sessions run) and every bundled plugin with its switch and settings. */
function Advanced() {
  const { providers, plugins } = useDaemon();
  const nodes = (providers ?? []).filter((p) => p.seam === "node");
  return (
    <>
      <Restart pending={plugins ? pluginCounts(plugins.plugins).pending : 0} />
      {nodes.length > 0 && (
        <SettingsSection title="Nodes" count={nodes.length}>
          {nodes.map((node) => (
            <SettingsRow
              key={node.id}
              data-node={node.id}
              title={node.name}
              description={node.detail}
              control={
                <StateDot
                  {...(node.state === "connected"
                    ? {
                        word: node.enabled ? "Ready" : "Off",
                        dot: node.enabled ? "bg-green" : "bg-text-3",
                        ink: "text-text-2",
                      }
                    : {
                        word: node.state === "missing" ? "Not installed" : "Not ready",
                        dot: "bg-amber",
                        ink: "text-amber",
                      })}
                />
              }
            />
          ))}
        </SettingsSection>
      )}
      <PluginList />
    </>
  );
}

function Value({ children }: { children: ReactNode }) {
  return <span className="select-text break-all font-mono text-small text-text-soft tnum">{children}</span>;
}

function Unreported() {
  return <span className="text-small text-text-3">Not reported by this daemon</span>;
}
