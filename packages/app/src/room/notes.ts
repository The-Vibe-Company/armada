// The room's own lines (THE-2128), kept per project for the app's session: a
// room left and opened again shows them, a reload forgets them. They are
// never sent to the coordinator; `withNotes` puts them in the thread by time.
import { useSyncExternalStore } from "react";
import type { RoomNote } from "./chat";

const notes = new Map<string, readonly RoomNote[]>();
const listeners = new Set<() => void>();
const NONE: readonly RoomNote[] = [];
let count = 0;

export function addNote(project: string, body: string, at = new Date(Date.now())): void {
  const note: RoomNote = { kind: "note", id: `note:${++count}`, at: at.toISOString(), body };
  notes.set(project, [...(notes.get(project) ?? NONE), note]);
  for (const listener of listeners) listener();
}

export function useNotes(project: string): readonly RoomNote[] {
  const read = () => notes.get(project) ?? NONE;
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    read,
  );
}
