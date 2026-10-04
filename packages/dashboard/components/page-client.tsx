"use client";

// The parts of the page kit (components/page.tsx) that need the shell: the
// header bar with its slot for a page's actions.
import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";

const HeaderSlot = createContext<HTMLElement | null>(null);
const SetHeaderSlot = createContext<((el: HTMLElement | null) => void) | null>(null);

/** Gives the header bar's actions slot to the page under it; the shell wraps the header and the page in it. */
export function HeaderSlotProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <SetHeaderSlot.Provider value={setSlot}>
      <HeaderSlot.Provider value={slot}>{children}</HeaderSlot.Provider>
    </SetHeaderSlot.Provider>
  );
}

/**
 * The 44 px bar on top of every page: its title (the breadcrumbs) on the
 * left, the page's actions on the right. The shell draws it; pages never
 * draw a title of their own. `heading` is the page's one h1, for screen
 * readers (THE-891): the breadcrumbs already show it.
 */
export function PageHeader({
  title,
  heading,
  sample = false,
}: {
  title: ReactNode;
  heading?: string;
  sample?: boolean;
}) {
  const setSlot = useContext(SetHeaderSlot);
  return (
    <header className="ui-header">
      {heading && <h1 className="sr-only">{heading}</h1>}
      {title}
      <span className="spacer" />
      {!sample && setSlot && <span className="ui-header-actions" ref={setSlot} />}
    </header>
  );
}

/** A page's buttons in the header bar, on its right: "Linear ↗", "PR #12", a refresh. */
export function HeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlot);
  return slot ? createPortal(children, slot) : null;
}
