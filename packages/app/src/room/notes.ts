// The room's own lines (THE-2128), kept per project for the app's session: a
// room left and opened again shows them, a reload forgets them. They are
// never sent to the coordinator; `withNotes` puts them in the thread by time.
// A model chosen during a turn waits here too, so leaving the room keeps it.
import { useSyncExternalStore } from "react";
import type { RoomNote } from "./chat";

const notes = new Map<string, readonly RoomNote[]>();
/** A model chosen during a turn, by project, until that turn ends. */
export type Waiting = { provider: string; model: string };
const waiting = new Map<string, Waiting>();
const listeners = new Set<() => void>();
const NONE: readonly RoomNote[] = [];
let count = 0;

const changed = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function addNote(project: string, body: string, at = new Date(Date.now())): void {
  const note: RoomNote = { kind: "note", id: `note:${++count}`, at: at.toISOString(), body };
  notes.set(project, [...(notes.get(project) ?? NONE), note]);
  changed();
}

/** Sets (or, with null, clears) the model waiting for the project's next turn. */
export function setWaiting(project: string, choice: Waiting | null): void {
  if (choice) waiting.set(project, choice);
  else waiting.delete(project);
  changed();
}

/** Takes the model waiting for the project's next turn, once: a second call finds none. */
export function takeWaiting(project: string): Waiting | null {
  const choice = waiting.get(project) ?? null;
  if (choice) setWaiting(project, null);
  return choice;
}

export function useWaiting(project: string): Waiting | null {
  const read = () => waiting.get(project) ?? null;
  return useSyncExternalStore(subscribe, read, read);
}

export function useNotes(project: string): readonly RoomNote[] {
  const read = () => notes.get(project) ?? NONE;
  return useSyncExternalStore(subscribe, read, read);
}
