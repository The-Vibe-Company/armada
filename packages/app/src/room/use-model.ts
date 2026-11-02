// The room's model switch (THE-2128): a choice goes through the client's
// `select` (the project's own model when its rules name one, else the shared
// selection); during a turn it waits for the next one, the label saying so;
// once it applies, the room says so in its own line (`notes.ts`).
import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "@/protocol/client";
import { type CatalogProvider, selectionLabel } from "@/settings/models";
import { modelLine, type RoomModel } from "./model";
import { addNote } from "./notes";

type Choice = { provider: string; model: string };

export function useModelSwitch({
  project,
  client,
  model,
  providers,
  busy,
}: {
  project: string;
  /** None where the room is drawn without a daemon (a test's synthetic room): nothing can be chosen. */
  client: Pick<DaemonClient, "select"> | undefined;
  model: RoomModel;
  providers: readonly CatalogProvider[];
  /** A coordinator turn is running: a new model applies at the next one. */
  busy: boolean;
}): { label: string | null; pending: boolean; choose(provider: string, model: string): Promise<void> } {
  const [waiting, setWaiting] = useState<Choice | null>(null);
  const busyNow = useRef(busy);
  busyNow.current = busy;
  useEffect(() => {
    if (busy || !waiting) return;
    addNote(project, modelLine(waiting.provider, waiting.model));
    setWaiting(null);
  }, [busy, waiting, project]);
  const { selected, scope } = model;
  const choose = useCallback(
    async (provider: string, chosen: string) => {
      if (selected?.provider === provider && selected.model === chosen) return;
      if (!client) throw new Error("Waiting for the daemon.");
      await client.select(provider, chosen, scope === "project" ? project : undefined);
      if (busyNow.current) setWaiting({ provider, model: chosen });
      else addNote(project, modelLine(provider, chosen));
    },
    [client, project, scope, selected],
  );
  return { label: waiting ? selectionLabel(waiting, providers) : model.label, pending: waiting !== null, choose };
}
