// The room's model switch (THE-2128): a choice goes through the client's
// `select` (the project's own model when its rules name one, else the shared
// selection); during a turn it waits for the next one, the label saying so;
// once it applies, the room says so in its own line (`notes.ts`, which keeps
// the waiting choice for the session: leaving the room does not lose it).
import { useCallback, useEffect, useRef } from "react";
import type { DaemonClient } from "@/protocol/client";
import { type CatalogProvider, selectionLabel } from "@/settings/models";
import { modelLine, type RoomModel } from "./model";
import { addNote, setWaiting, takeWaiting, useWaiting } from "./notes";

export function useModelSwitch({
  project,
  client,
  model,
  providers,
  busy,
  known,
}: {
  project: string;
  /** None where the room is drawn without a daemon (a test's synthetic room): nothing can be chosen. */
  client: Pick<DaemonClient, "select"> | undefined;
  model: RoomModel;
  providers: readonly CatalogProvider[];
  /** A coordinator turn is running: a new model applies at the next one. */
  busy: boolean;
  /** The room has read the coordinator's turn (or the daemon streams none): until then, idle means unknown. */
  known: boolean;
}): { label: string | null; pending: boolean; choose(provider: string, model: string): Promise<void> } {
  const waiting = useWaiting(project);
  const busyNow = useRef(busy);
  busyNow.current = busy;
  useEffect(() => {
    if (busy || !known || !waiting) return;
    const applied = takeWaiting(project);
    if (applied) addNote(project, modelLine(applied.provider, applied.model));
  }, [busy, known, waiting, project]);
  const { selected, scope } = model;
  const choose = useCallback(
    async (provider: string, chosen: string) => {
      if (selected?.provider === provider && selected.model === chosen) return;
      if (!client) throw new Error("Waiting for the daemon.");
      await client.select(provider, chosen, scope === "project" ? project : undefined);
      if (busyNow.current) setWaiting(project, { provider, model: chosen });
      else addNote(project, modelLine(provider, chosen));
    },
    [client, project, scope, selected],
  );
  return { label: waiting ? selectionLabel(waiting, providers) : model.label, pending: waiting !== null, choose };
}
