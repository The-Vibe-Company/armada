// The coordinator's model on the composer's footer (THE-2128): the quiet mono
// label becomes a button that opens Settings' picker in place, above the
// footer, on a click or ⌘⇧M; Escape, a click away or a choice closes it and
// the focus goes back to the field. A provider not connected is listed as in
// Settings, with "Connect in Settings": connecting never happens in the chat.
// The rules are `model.ts`'s; the room says the switch in its own line.
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ModelPickerContent } from "@/settings/ModelPicker";
import type { CatalogProvider } from "@/settings/models";
import { CONNECT_IN_SETTINGS, NEXT_TURN, type RoomModel, scopeLine } from "./model";

/** ⌘⇧M (Ctrl+Shift+M off the Mac) opens or closes the picker. */
export const isPickerKey = (e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}) => (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "m";

export function ComposerModel({
  model,
  label,
  pending,
  providers,
  onChoose,
  focusField,
  fail,
}: {
  model: RoomModel;
  /** What the label reads: the chosen model, the one waiting for the next turn included. */
  label: string;
  /** A choice made during a turn waits for the next one. */
  pending: boolean;
  providers: readonly CatalogProvider[];
  onChoose(provider: string, model: string): Promise<void>;
  focusField(): void;
  /** Says why a choice failed, under the field. */
  fail(problem: string): void;
}) {
  const [open, setOpen] = useState(false);
  /** Above the footer, where the docked field leaves the room; under it when the field is high (the empty room's hero). */
  const [below, setBelow] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const opened = useRef(open);
  opened.current = open;
  const changeable = model.changeable;

  const toggle = useCallback(() => {
    if (opened.current) {
      setOpen(false);
      focusField();
      return;
    }
    const box = root.current?.getBoundingClientRect();
    setBelow(box !== undefined && box.top < window.innerHeight - box.bottom);
    setOpen(true);
  }, [focusField]);

  useEffect(() => {
    if (!changeable) return;
    function onKey(event: KeyboardEvent) {
      if (!isPickerKey(event) || event.defaultPrevented) return;
      event.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changeable, toggle]);

  useEffect(() => {
    if (!open) return;
    function away(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const text = (
    <>
      <span className="min-w-0 truncate">{label}</span>
      {pending && <span className="flex-none text-text-3/80"> · {NEXT_TURN}</span>}
    </>
  );
  if (!changeable)
    return (
      <span className="flex min-w-0 font-mono text-body text-text-3" title="The coordinator's model" data-model-label>
        {text}
      </span>
    );
  function close() {
    setOpen(false);
    focusField();
  }
  return (
    <div ref={root} className="relative flex min-w-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Coordinator model: ${label}${pending ? `, ${NEXT_TURN}` : ""}`}
        aria-keyshortcuts="Meta+Shift+M Control+Shift+M"
        title="The coordinator's model (⌘⇧M)"
        data-model-label
        onClick={toggle}
        className={cn(
          "-mx-1.5 flex min-w-0 cursor-pointer items-baseline rounded-sm px-1.5 font-mono text-body text-text-3 outline-none transition-colors",
          "hover:bg-item-hover hover:text-text-2 focus-visible:ring-2 focus-visible:ring-blue aria-expanded:text-text-2",
        )}
      >
        {text}
      </button>
      {open && (
        <ModelPickerContent
          providers={providers}
          selected={model.selected}
          head={scopeLine(model.scope)}
          unavailable={CONNECT_IN_SETTINGS}
          className={cn("absolute left-0 z-20", below ? "top-full mt-2" : "bottom-full mb-2")}
          onClose={close}
          onChoose={(provider, chosen) => {
            close();
            onChoose(provider, chosen).catch((error: unknown) =>
              fail(error instanceof Error ? error.message : "The model was not changed. Try again."),
            );
          }}
        />
      )}
    </div>
  );
}
