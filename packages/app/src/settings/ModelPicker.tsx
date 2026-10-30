// The coordinator's model picker (THE-2070), after T3 Code's
// ProviderModelPicker and ModelPickerContent (pingdotgg/t3code, without
// favourites, traits or usage): a button with the chosen model, opening a
// popover with a search field and the catalog's models grouped by provider,
// each row its name, a "reasoning" chip and its context, the chosen one
// checked; a provider not connected is listed dimmed, "Connect first".
import { Check, ChevronDown, Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { type CatalogProvider, modelKey, modelLabel, pickerGroups } from "./models";
import { ProviderMark } from "./ProviderMark";

export function ModelPicker({
  providers,
  selected,
  label,
  disabled,
  onSelect,
}: {
  providers: readonly CatalogProvider[];
  /** The chosen pi model, checked in the list. */
  selected: { provider: string; model: string } | null;
  /** What the button reads. */
  label: string;
  disabled?: boolean;
  onSelect(provider: string, model: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useId();
  const groups = useMemo(() => pickerGroups(providers, query), [providers, query]);
  const choices = useMemo(
    () => groups.flatMap((g) => (g.available ? g.models.map((m) => modelKey(g.provider.id, m.id)) : [])),
    [groups],
  );
  const chosen = selected ? modelKey(selected.provider, selected.model) : null;
  const current = active && choices.includes(active) ? active : (choices[0] ?? null);

  useEffect(() => {
    if (!open) return;
    function away(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  function show() {
    setQuery("");
    setActive(chosen);
    setOpen(true);
  }
  function choose(key: string) {
    const [provider, ...model] = key.split("/");
    if (!provider || model.length === 0) return;
    setOpen(false);
    trigger.current?.focus();
    onSelect(provider, model.join("/"));
  }
  function keys(event: KeyboardEvent<HTMLInputElement>) {
    const at = current ? choices.indexOf(current) : -1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (choices.length === 0) return;
      const next = event.key === "ArrowDown" ? (at + 1) % choices.length : (at - 1 + choices.length) % choices.length;
      setActive(choices[next] ?? null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (current) choose(current);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
  }
  const optionId = (key: string) => `${list}-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  return (
    <div ref={root} className="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${label}`}
        data-model-picker
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        className="inline-flex h-7.5 max-w-72 cursor-pointer items-center gap-1.75 rounded-control bg-card px-3 font-medium text-body text-text shadow-control outline-none transition-[background-color,box-shadow] hover:not-disabled:bg-panel-3 focus-visible:ring-2 focus-visible:ring-blue disabled:cursor-default disabled:opacity-50"
      >
        {selected && <ProviderMark provider={selected.provider} className="size-3.5" />}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown aria-hidden className="size-3.5 flex-none text-text-3" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Choose the coordinator's model"
          className="absolute top-full right-0 z-20 mt-1.5 flex w-[min(360px,80vw)] flex-col overflow-hidden rounded-card bg-panel-3 shadow-pop"
        >
          <div className="flex items-center gap-2 border-line-soft border-b px-3">
            <Search aria-hidden className="size-3.5 flex-none text-text-3" />
            <input
              // biome-ignore lint/a11y/noAutofocus: the popover opens on the search, as a menu would on its first item.
              autoFocus
              role="combobox"
              aria-expanded
              aria-controls={list}
              aria-autocomplete="list"
              aria-activedescendant={current ? optionId(current) : undefined}
              aria-label="Search models"
              placeholder="Search models"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setActive(null);
              }}
              onKeyDown={keys}
              spellCheck={false}
              autoComplete="off"
              className="h-9 min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text-3"
            />
          </div>
          <div id={list} role="listbox" aria-label="Models" className="max-h-[min(420px,60vh)] overflow-y-auto py-1">
            {groups.length === 0 && <p className="m-0 px-3 py-3 text-small text-text-3">No model matches.</p>}
            {groups.map((group) => {
              const heading = `${list}-${group.provider.id}`;
              return (
                // biome-ignore lint/a11y/useSemanticElements: a listbox's option group, not a form's fieldset.
                <div
                  key={group.provider.id}
                  role="group"
                  aria-labelledby={heading}
                  data-picker-group={group.provider.id}
                  className="py-1"
                >
                  <div
                    id={heading}
                    className={cn(
                      "flex items-center gap-2 px-3 pt-1 pb-1 text-label text-text-3",
                      !group.available && "opacity-70",
                    )}
                  >
                    <ProviderMark provider={group.provider.id} className="size-3" />
                    <span className="min-w-0 flex-1 truncate font-medium">{group.provider.name}</span>
                    {group.reason && <span data-reason>{group.reason}</span>}
                  </div>
                  {group.models.map((model) => {
                    const key = modelKey(group.provider.id, model.id);
                    const text = modelLabel(model);
                    const isChosen = key === chosen;
                    return (
                      // biome-ignore lint/a11y/useFocusableInteractive: the search field keeps the focus; the options are its active descendants.
                      <div
                        key={key}
                        id={optionId(key)}
                        role="option"
                        aria-selected={isChosen}
                        aria-disabled={!group.available}
                        title={group.reason ?? undefined}
                        data-model={key}
                        data-active={key === current ? "" : undefined}
                        onPointerMove={() => group.available && setActive(key)}
                        onClick={() => group.available && choose(key)}
                        onKeyDown={() => {}}
                        className={cn(
                          "mx-1 flex min-h-8 items-center gap-2 rounded-sm px-2 text-body",
                          group.available
                            ? "cursor-pointer text-text data-active:bg-item-hover"
                            : "text-text-3 opacity-60",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{text.name}</span>
                        {text.reasoning && (
                          <span className="rounded-xs bg-fill px-1.5 text-label text-text-2">reasoning</span>
                        )}
                        {text.context && (
                          <span className="w-10 text-right font-mono text-label text-text-3 tnum">{text.context}</span>
                        )}
                        <Check aria-hidden className={cn("size-3.5 flex-none", !isChosen && "invisible")} />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
