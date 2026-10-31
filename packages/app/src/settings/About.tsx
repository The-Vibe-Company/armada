import { PROTOCOL_VERSION } from "@armada/protocol";
import { type ReactNode, useEffect, useState } from "react";
import { fleetOf } from "@/fleet/state";
import { useDaemon } from "@/protocol/store";
import { SettingsRow, SettingsSection } from "./Layout";

/** The app's version, from its package.json (vite.config.ts); a test's static render has none. */
const APP_VERSION = typeof __ARMADA_APP_VERSION__ === "string" ? __ARMADA_APP_VERSION__ : null;

/**
 * Settings' About: where the daemon is and which versions speak. The daemon
 * reports only its protocol's minor today; its own version and its data
 * folder say so until the protocol carries them.
 */
export function About({ address }: { address: string }) {
  const { minor, fleets } = useDaemon();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const hour = new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString();
  const usages = Object.values(fleets).flatMap((snapshot) => {
    const usage = fleetOf(snapshot).readers?.linear;
    return usage ? [usage] : [];
  });
  const requests = usages.reduce((total, usage) => total + (usage.hour === hour ? usage.requests : 0), 0);
  const app = `${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}`;
  return (
    <>
      <SettingsSection title="Daemon">
        <SettingsRow
          title="Address"
          description="Where this app reaches the daemon."
          control={<Value>{address}</Value>}
        />
        <SettingsRow
          title="Linear"
          description="The daemon's Linear API use across projects."
          control={usages.length ? <Value>Linear: {requests} requests this hour</Value> : <Unreported />}
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
    </>
  );
}

function Value({ children }: { children: ReactNode }) {
  return <span className="select-text break-all font-mono text-small text-text-soft tnum">{children}</span>;
}

function Unreported() {
  return <span className="text-small text-text-3">Not reported by this daemon</span>;
}
