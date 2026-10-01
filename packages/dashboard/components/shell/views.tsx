"use client";

// The viewer's saved views (THE-895), as the sidebar pins them and the
// FilterBar saves them. With accounts they are the person's, in the app's
// database (app/views-actions.ts); under the shared-password gate, where
// nobody is a person, they stay in this browser.
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { deleteView, saveView, type ViewResult } from "@/app/views-actions";
import { checkView, type SavedView, VIEWS_MAX, type ViewError } from "@/lib/filters";

const LOCAL_KEY = "armada-views";

export interface Views {
  views: SavedView[];
  /** Kept in this browser (the password gate), not for the person. */
  local: boolean;
  save: (input: Omit<SavedView, "id">) => Promise<ViewError | null>;
  remove: (id: string) => Promise<void>;
}

const NONE: Views = { views: [], local: true, save: async () => "failed", remove: async () => {} };
const ViewsContext = createContext<Views>(NONE);

function readLocal(): SavedView[] {
  try {
    const list = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "[]") as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((v: Partial<SavedView>) => {
      const checked = checkView({ name: v?.name, list: v?.list, query: v?.query });
      return checked.ok && typeof v.id === "string" ? [{ id: v.id, ...checked.view }] : [];
    });
  } catch {
    return [];
  }
}

const writeLocal = (views: SavedView[]) => {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(views));
  } catch {
    // Private mode or a full storage: the view lasts this page only.
  }
};

/** `initial`: the person's views from the server; null under the password gate. */
export function ViewsProvider({ initial, children }: { initial: SavedView[] | null; children: ReactNode }) {
  const local = initial === null;
  const [views, setViews] = useState<SavedView[]>(initial ?? []);
  // The browser's views, once it is the browser: the server's HTML had none.
  // A new render from the server (another organization, a refresh) brings the person's views there.
  useEffect(() => {
    setViews(initial ?? readLocal());
  }, [initial]);

  const save = useCallback(
    async (input: Omit<SavedView, "id">): Promise<ViewError | null> => {
      if (local) {
        const checked = checkView(input);
        if (!checked.ok) return checked.problem;
        const list = readLocal();
        const same = list.find((v) => v.name === checked.view.name);
        if (!same && list.length >= VIEWS_MAX) return "full";
        const next = same
          ? list.map((v) => (v.id === same.id ? { ...v, ...checked.view } : v))
          : [...list, { id: `local-${Date.now().toString(36)}`, ...checked.view }];
        writeLocal(next);
        setViews(next);
        return null;
      }
      const form = new FormData();
      form.set("name", input.name);
      form.set("list", input.list);
      form.set("query", input.query);
      const result = await saveView(form).catch((): ViewResult => ({ ok: false, problem: "failed" }));
      if (!result.ok) return result.problem;
      setViews(result.views);
      return null;
    },
    [local],
  );

  const remove = useCallback(
    async (id: string) => {
      if (local) {
        const next = readLocal().filter((v) => v.id !== id);
        writeLocal(next);
        setViews(next);
        return;
      }
      // Gone at once; the server's list follows.
      setViews((list) => list.filter((v) => v.id !== id));
      const form = new FormData();
      form.set("id", id);
      const result = await deleteView(form).catch(() => null);
      if (result?.ok) setViews(result.views);
    },
    [local],
  );

  const value = useMemo(() => ({ views, local, save, remove }), [views, local, save, remove]);
  return <ViewsContext.Provider value={value}>{children}</ViewsContext.Provider>;
}

/** The viewer's saved views; none outside the shell (the landing's replica). */
export const useViews = () => useContext(ViewsContext);
