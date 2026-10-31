// The settings' nav (THE-2075, after T3 Code's SettingsSidebarNav and
// SettingsBreadcrumb, pingdotgg/t3code): rows under their group's label
// (Coordinator; Agents › Providers; Connections › Linear, GitHub, Armada;
// About), and above the section the breadcrumb "Settings / Providers" with
// the close button that returns to the screen the settings were opened from.
import { X } from "lucide-react";
import type { ComponentType, KeyboardEvent, ReactNode } from "react";
import { type SettingsSection, settingsHref, settingsReturn } from "@/lib/route";

export interface NavRow {
  section: SettingsSection;
  /** The card the row opens (a connection), if not the section alone. */
  detail?: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}
export interface NavGroup {
  /** The group's label; none for a row standing alone (Coordinator, About). */
  label?: string;
  rows: readonly NavRow[];
}

/** Whether a row is the one shown: its section, and its card when it names one. */
const isCurrent = (row: NavRow, section: SettingsSection, detail: string | undefined) =>
  row.section === section && (row.detail === undefined || row.detail === detail);

/**
 * One link per row, the current one filled and `aria-current`. The arrow keys
 * move between them (one tab stop: the current row, else the first). When the
 * settings are narrower than 720 px (the shell keeps the window at 720 px or
 * more, so the settings' own width decides) the labels leave and the nav is
 * an icon rail, each icon telling its label in a tooltip on hover or focus.
 */
export function SettingsNav({
  groups,
  section,
  detail,
}: {
  groups: readonly NavGroup[];
  section: SettingsSection;
  detail?: string;
}) {
  function move(event: KeyboardEvent<HTMLElement>) {
    // Alt+Left, ⌘+Left and the like are the browser's (Back): leave them alone.
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>("a[data-section]")];
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? (at + 1) % links.length
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? (at - 1 + links.length) % links.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? links.length - 1
              : null;
    if (next === null || at === -1) return;
    event.preventDefault();
    links[next]?.focus();
  }
  const rows = groups.flatMap((g) => g.rows);
  const stop = rows.find((row) => isCurrent(row, section, detail)) ?? rows[0];
  return (
    <nav
      aria-label="Settings sections"
      onKeyDown={move}
      className="flex w-50 flex-none flex-col gap-3 @max-[720px]/settings:w-9"
    >
      {groups.map((group, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the groups are a fixed list; a lone row has no label.
        <div key={index} className="flex flex-col gap-0.5">
          {group.label && (
            <span
              data-nav-group
              className="px-2 pb-1 font-medium text-label text-text-3 uppercase tracking-[0.06em] @max-[720px]/settings:sr-only"
            >
              {group.label}
            </span>
          )}
          {group.rows.map((row) => {
            const { section: s, detail: d, label, icon: Icon } = row;
            return (
              <a
                key={`${s}/${d ?? ""}`}
                href={settingsHref(s, d)}
                data-section={d ? `${s}/${d}` : s}
                aria-current={isCurrent(row, section, detail) ? "page" : undefined}
                tabIndex={row === stop ? 0 : -1}
                className="group relative flex h-item items-center gap-2 whitespace-nowrap rounded-sm px-2 text-text-2 outline-none transition-colors hover:bg-item-hover hover:text-text focus-visible:ring-2 focus-visible:ring-blue aria-[current=page]:bg-item-current aria-[current=page]:text-text @max-[720px]/settings:justify-center @max-[720px]/settings:px-0"
              >
                <Icon className="size-4 flex-none" />
                <span className="min-w-0 truncate @max-[720px]/settings:sr-only">{label}</span>
                {/* The rail's tooltip: the label is already the link's name, so it is only seen. */}
                <span
                  aria-hidden
                  data-rail-tooltip
                  className="pointer-events-none absolute top-1/2 left-full z-10 ml-2 hidden -translate-y-1/2 rounded-sm bg-overlay px-2 py-1 text-small text-text shadow-pop @max-[720px]/settings:group-hover:block @max-[720px]/settings:group-focus-visible:block"
                >
                  {label}
                </span>
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** "Settings / Providers" over the section, and the close button back to where the settings were opened from. */
export function SettingsBreadcrumb({ label }: { label: string }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-4 px-1">
      <nav aria-label="Settings breadcrumb" className="min-w-0">
        <ol className="m-0 flex list-none items-center gap-1.5 p-0 text-meta text-text-3">
          <li>Settings</li>
          <li aria-hidden>/</li>
          <li aria-current="page" className="truncate text-text">
            {label}
          </li>
        </ol>
      </nav>
      <a
        href={settingsReturn()}
        aria-label="Close settings"
        title="Close settings"
        className="-mr-1 flex size-7 flex-none items-center justify-center rounded-sm text-text-2 outline-none hover:bg-item-hover hover:text-text focus-visible:ring-2 focus-visible:ring-blue"
      >
        <X aria-hidden className="size-4" strokeWidth={1.75} />
      </a>
    </div>
  );
}

/** The nav and the chosen section side by side; the container the rail's width is read from. */
export function SettingsFrame({ nav, children }: { nav: ReactNode; children: ReactNode }) {
  return (
    <div className="@container/settings">
      <div className="flex min-w-0 items-start gap-8 @max-[720px]/settings:gap-4">
        {nav}
        <div className="flex min-w-0 flex-1 flex-col gap-7">{children}</div>
      </div>
    </div>
  );
}
