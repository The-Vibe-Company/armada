"use client";

import type { SandboxStatus } from "@armada/core";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useMemo,
  useState,
} from "react";

export type LiveThreadState = {
  status: SandboxStatus;
  idlePaused: boolean;
  statusMessage: string | null;
  hasLiveStatus: boolean;
  turnRunning: boolean;
};

export const ThreadStateContext = createContext<{
  live: LiveThreadState | null;
  setLive: Dispatch<SetStateAction<LiveThreadState | null>>;
} | null>(null);

export function SandboxThreadStateProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<LiveThreadState | null>(null);
  const value = useMemo(() => ({ live, setLive }), [live]);
  return <ThreadStateContext.Provider value={value}>{children}</ThreadStateContext.Provider>;
}

export function useThreadSandboxStatus(initialStatus: SandboxStatus) {
  return useContext(ThreadStateContext)?.live?.status ?? initialStatus;
}
