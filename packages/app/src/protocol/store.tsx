import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import { type DaemonClient, type DaemonState, initialState } from "./client";

const DaemonContext = createContext<DaemonClient | null>(null);

/** Hands the screens one daemon client; the screens read it with `useDaemon`. */
export function DaemonProvider({ client, children }: { client: DaemonClient; children: ReactNode }) {
  return <DaemonContext.Provider value={client}>{children}</DaemonContext.Provider>;
}

const still = () => initialState;
const nothing = () => () => {};

/** The subscribed state, re-rendered on each change; the first reading before any client. */
export function useDaemon(): DaemonState {
  const client = useContext(DaemonContext);
  return useSyncExternalStore(client?.subscribe ?? nothing, client?.getState ?? still, client?.getState ?? still);
}
