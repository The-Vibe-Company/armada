"use client";

// The parts of the page kit (components/page.tsx) that need the shell: the
// header bar with its slot for a page's actions, and the density toggle.
import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { DENSITIES } from "@/lib/fleet-view";
import { useShell } from "./shell/context";
import { Tabs } from "./ui";

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
 * The 48 px bar on top of every page: its title (the breadcrumbs) on the
 * left, its key hints and the page's actions on the right. The shell draws
 * it; pages never draw a title of their own. `heading` is the page's one h1,
 * for screen readers (THE-891): the breadcrumbs already show it.
 */
export function PageHeader({
  title,
  heading,
  hints,
  sample = false,
}: {
  title: ReactNode;
  heading?: string;
  hints?: ReactNode;
  sample?: boolean;
}) {
  const setSlot = useContext(SetHeaderSlot);
  return (
    <header className="ui-header">
      {heading && <h1 className="sr-only">{heading}</h1>}
      {title}
      <span className="spacer" />
      {!sample && setSlot && <span className="ui-header-actions" ref={setSlot} />}
      {hints && <span className="ui-header-hints">{hints}</span>}
    </header>
  );
}

/** A page's buttons in the header bar, on its right: "Linear ↗", "PR #12", a refresh. */
export function HeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlot);
  return slot ? createPortal(children, slot) : null;
}

/** Compact or airy, as the viewer chose it; for a page's toolbar. */
export function DensityToggle() {
  const { t, density, setDensity } = useShell();
  return (
    <Tabs
      label={t.shell.density.label}
      value={density}
      onChange={setDensity}
      items={DENSITIES.map((d) => ({ key: d, label: t.shell.density[d] }))}
    />
  );
}
