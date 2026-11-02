// The coordinator's model in the room (THE-2128), pure: which model the room's
// coordinator runs on (the project's own, from its rules, else the shared
// selection of pi's catalog, else the model plugins' saved one), what the
// chat bar's label reads, what a choice there edits, and the room's quiet
// line once a new model applies. `ComposerModel.tsx` draws it; the picker is
// Settings' (`settings/ModelPicker.tsx`, `settings/models.ts`).
import { MODEL_SCOPE_MINOR } from "@armada/protocol";
import type { DaemonState } from "@/protocol/client";
import { modelKey, piSelection, projectOverride, selectionLabel } from "@/settings/models";
import { coordinatorModel } from "./compose";

export interface RoomModel {
  /** The label under the field; null when no model is known (nothing is shown). */
  label: string | null;
  /** The pi model the picker checks. */
  selected: { provider: string; model: string } | null;
  /** What a choice edits: the project's own model, or the one every project shares. */
  scope: "project" | "shared";
  /** The picker opens: the daemon lists pi's catalog and can edit what applies here. */
  changeable: boolean;
}

/** The room's coordinator model from the daemon's state and the project's folded state. */
export function roomModel(daemon: Pick<DaemonState, "catalog" | "credentials" | "minor">, state: unknown): RoomModel {
  const override = projectOverride(state);
  const scope = override ? "project" : "shared";
  const catalog = daemon.catalog;
  if (!catalog) return { label: coordinatorModel(daemon.credentials), selected: null, scope, changeable: false };
  const effective = override ?? catalog.selected;
  const label = selectionLabel(effective, catalog.providers) ?? coordinatorModel(daemon.credentials);
  return {
    label,
    selected: piSelection(effective),
    scope,
    // A project's own model is edited through `models.select`'s project, from minor 24.
    changeable: label !== null && (scope === "shared" || (daemon.minor ?? 0) >= MODEL_SCOPE_MINOR),
  };
}

/** The picker's head: what the choice applies to. */
export const scopeLine = (scope: RoomModel["scope"]) =>
  scope === "project" ? "For this project" : "For every project";

/** A dimmed provider's hint in the room: connecting happens in Settings, never in the chat. */
export const CONNECT_IN_SETTINGS = "Connect in Settings";

/** The room's line once the coordinator runs on a new model. */
export const modelLine = (provider: string, model: string) => `Coordinator now on ${modelKey(provider, model)}`;

/** The label while a choice waits for the running turn to end. */
export const NEXT_TURN = "next turn";
