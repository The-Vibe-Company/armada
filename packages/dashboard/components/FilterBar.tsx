"use client";

// A list's filters (THE-895), in its address: project, harness, state or
// phase, profile, "needs me", words, and an order. Each choice is a new entry
// in the history, so back and forward step through the views; typing
// replaces the entry it started, so one search is one step. The page reads
// the same URL (`useListFilters`), so a link opens the same view. "Save
// view" names the filters and pins them in the sidebar (saved views).
import { LABEL_PHASES } from "@armada/core/read";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewError } from "@/lib/filters";
import {
  type BarList,
  type FilterField,
  type FilterList,
  filterHref,
  filterQuery,
  hasFilters,
  LISTS,
  type ListFilters,
  parseFilters,
  profileOf,
  type SortKey,
} from "@/lib/filters";
import { AGENT_STATUSES, HARNESS_NAME, HARNESSES } from "@/lib/fleet-view";
import { Button, Form, Input, Select, Toolbar } from "./page";
import { useFleet, useShell } from "./shell/context";
import { useViews } from "./shell/views";

/** Typing waits this long before it writes the address. */
const TYPE_MS = 250;

/** The list's filters, read from the address, and how to change them. */
export function useListFilters(list: BarList) {
  const params = useSearchParams();
  const router = useRouter();
  const filters = useMemo(() => parseFilters(list, params), [list, params]);
  const hrefFor = useCallback(
    (patch: Partial<ListFilters>) => filterHref(list, { ...filters, ...patch }),
    [list, filters],
  );
  const go = useCallback(
    (patch: Partial<ListFilters>, how: "push" | "replace" = "push") => router[how](hrefFor(patch), { scroll: false }),
    [router, hrefFor],
  );
  return { filters, go, hrefFor };
}

/** A list's filters, their links and how to change them: the address's (`useListFilters`), or a still view's. */
export type ListFilterControl = ReturnType<typeof useListFilters>;

export function FilterBar({
  list,
  omit = [],
}: {
  list: BarList;
  /** Fields the page already shows another way (the Agents page's harness tabs). */
  omit?: FilterField[];
}) {
  const { filters, go } = useListFilters(list);
  return <FilterFields list={list} omit={omit} filters={filters} go={go} />;
}

/** The bar itself, on the filters it is given: the landing's replica (no router) shows it on none. */
export function FilterFields({
  list,
  omit = [],
  filters,
  go,
}: { list: BarList; omit?: FilterField[] } & Pick<ListFilterControl, "filters" | "go">) {
  const { t } = useShell();
  const { overview } = useFleet();
  const f = t.filters;
  const fields = (LISTS[list].fields as readonly FilterField[]).filter((x) => !omit.includes(x));
  const has = (x: FilterField) => fields.includes(x);
  const profiles = useMemo(
    () =>
      [
        ...new Set([
          ...overview.rows.flatMap((r) => profileOf(r) ?? []),
          ...overview.projects.flatMap((p) => p.profiles.map((x) => x.name)),
        ]),
      ].sort(),
    [overview],
  );

  return (
    <Toolbar end={<Actions list={list} filters={filters} onClear={() => go({ ...clearAll })} />}>
      {has("q") && <TextFilter value={filters.q} onType={(q, how) => go({ q }, how)} label={f.search} />}
      {has("project") && overview.projects.length > 1 && (
        <Select
          aria-label={f.project}
          value={filters.project ?? ""}
          onChange={(e) => go({ project: e.target.value || null })}
        >
          <option value="">{f.allProjects}</option>
          {overview.projects.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </Select>
      )}
      {has("harness") && (
        <Select
          aria-label={f.harness}
          value={filters.harness ?? ""}
          onChange={(e) => go({ harness: (e.target.value || null) as ListFilters["harness"] })}
        >
          <option value="">{f.allHarnesses}</option>
          {HARNESSES.map((h) => (
            <option key={h} value={h}>
              {HARNESS_NAME[h]}
            </option>
          ))}
        </Select>
      )}
      {has("state") && <StateFilter list={list} value={filters.state} onPick={(state) => go({ state })} />}
      {has("profile") && profiles.length > 0 && (
        <Select
          aria-label={f.profile}
          value={filters.profile ?? ""}
          onChange={(e) => go({ profile: e.target.value || null })}
        >
          <option value="">{f.anyProfile}</option>
          {profiles.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
      )}
      {has("mine") && (
        <Button
          type="button"
          className="fb-toggle"
          aria-pressed={filters.mine}
          onClick={() => go({ mine: !filters.mine })}
        >
          <span className="fb-check" aria-hidden />
          {f.mine}
        </Button>
      )}
      {has("sort") && (
        <Select
          aria-label={f.sort}
          value={filters.sort ?? ""}
          onChange={(e) => go({ sort: (e.target.value || null) as SortKey | null })}
        >
          <option value="">{f.sortDefault}</option>
          {LISTS[list].sorts.map((s) => (
            <option key={s} value={s}>
              {(f.sorts[list] as Record<string, string>)[s]}
            </option>
          ))}
        </Select>
      )}
    </Toolbar>
  );
}

const clearAll: Partial<ListFilters> = {
  project: null,
  harness: null,
  state: null,
  profile: null,
  mine: false,
  q: "",
  sort: null,
};

/** The words, written to the address once typing pauses; back and forward bring theirs back. */
function TextFilter({
  value,
  onType,
  label,
}: {
  value: string;
  onType: (q: string, how: "push" | "replace") => void;
  label: string;
}) {
  const { t } = useShell();
  const [text, setText] = useState(value);
  const sent = useRef(value);
  // The address moved without us (back, forward, a view, a link): show its words.
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => {
    const q = text.replace(/\s+/g, " ").trim();
    if (q === sent.current) return;
    const timer = setTimeout(() => {
      // A new search is a step of the history; refining it is not.
      const how = sent.current ? "replace" : "push";
      sent.current = q;
      onType(q, how);
    }, TYPE_MS);
    return () => clearTimeout(timer);
  }, [text, onType]);
  return (
    <Input
      type="search"
      className="fb-search"
      aria-label={label}
      placeholder={t.filters.searchPlaceholder}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        // Esc empties the field before it takes the page back.
        if (e.key === "Escape" && text) {
          e.stopPropagation();
          setText("");
        }
      }}
    />
  );
}

function StateFilter({
  list,
  value,
  onPick,
}: {
  list: BarList;
  value: string | null;
  onPick: (state: string | null) => void;
}) {
  const { t } = useShell();
  const f = t.filters;
  return (
    <Select aria-label={f.state} value={value ?? ""} onChange={(e) => onPick(e.target.value || null)}>
      <option value="">{f.anyState}</option>
      {list === "agents" && (
        <>
          <optgroup label={f.statuses}>
            {AGENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t.shell.groups[s]}
              </option>
            ))}
          </optgroup>
          <optgroup label={f.phases}>
            {LABEL_PHASES.map((p) => (
              <option key={p} value={p}>
                {t.shell.phases[p]}
              </option>
            ))}
          </optgroup>
        </>
      )}
      {list === "projects" &&
        LISTS.projects.states.map((h) => (
          <option key={h} value={h}>
            {t.projectPages.health[h]}
          </option>
        ))}
      {list === "validations" &&
        LISTS.validations.states.map((s) => (
          <option key={s} value={s}>
            {f.outcomes[s]}
          </option>
        ))}
    </Select>
  );
}

/** Clear the filters, and save them as a view under a name. */
function Actions({ list, filters, onClear }: { list: BarList; filters: ListFilters; onClear: () => void }) {
  const { t } = useShell();
  return (
    <>
      {hasFilters(filters) && (
        <Button type="button" tone="danger" onClick={onClear}>
          {t.filters.clear}
        </Button>
      )}
      <SaveView list={list} query={filterQuery(list, filters)} />
    </>
  );
}

/**
 * "Save view": names the list's filters (`query`, canonical), which ⌘K then
 * finds (THE-916). Shown on the list's own page, once a filter is set;
 * "Remove the view" instead while the page shows a saved one. /activity
 * (THE-894) uses it with its own address.
 */
export function SaveView({ list, query }: { list: FilterList; query: string }) {
  const { t } = useShell();
  const { save, remove, views } = useViews();
  const pathname = usePathname();
  const [naming, setNaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ViewError | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (naming) field.current?.focus();
  }, [naming]);

  if (naming)
    return (
      <Form
        aria-label={t.views.save}
        onSubmit={async (e) => {
          e.preventDefault();
          const name = String(new FormData(e.currentTarget).get("name") ?? "");
          setBusy(true);
          const problem = await save({ name, list, query });
          setBusy(false);
          setError(problem);
          if (problem) return field.current?.focus();
          setSaved(name.trim());
          setNaming(false);
          requestAnimationFrame(() => opener.current?.focus());
        }}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          setNaming(false);
          setError(null);
          requestAnimationFrame(() => opener.current?.focus());
        }}
      >
        <Input
          ref={field}
          name="name"
          aria-label={t.views.name}
          placeholder={t.views.namePlaceholder}
          maxLength={40}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "fb-view-error" : undefined}
        />
        <Button tone="primary" disabled={busy}>
          {t.views.pin}
        </Button>
        <Button
          type="button"
          onClick={() => {
            setNaming(false);
            setError(null);
          }}
        >
          {t.views.cancel}
        </Button>
        {error && (
          <span id="fb-view-error" className="fb-error" role="alert">
            {t.views.errors[error]}
          </span>
        )}
      </Form>
    );
  // The page this sits on is the list's own: a view of it opens it again.
  const shown = pathname === LISTS[list].path && query !== "";
  const current = shown ? views.find((v) => v.list === list && v.query === query) : undefined;
  return (
    <>
      <span className="sr-only" role="status">
        {saved ? t.views.saved(saved) : removed ? t.views.removed(removed) : ""}
      </span>
      {current ? (
        <Button
          ref={opener}
          type="button"
          onClick={() => {
            setSaved(null);
            setRemoved(current.name);
            void remove(current.id);
          }}
        >
          {t.views.remove(current.name)}
        </Button>
      ) : (
        shown && (
          <Button
            ref={opener}
            type="button"
            onClick={() => {
              setSaved(null);
              setRemoved(null);
              setNaming(true);
            }}
          >
            {t.views.save}
          </Button>
        )
      )}
    </>
  );
}
