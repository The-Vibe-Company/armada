// The room's header (THE-2085), after T3 Code's chat header (`ChatHeader.tsx`,
// `ThreadStatusIndicators.tsx`): one 44 px line, the project's name and its
// repository, then on the right a pill per state that holds an agent (its dot,
// its number, its words), most urgent first, each opening the panel's Agents
// at its group; a provider read long ago, quietly; the panel's toggle. On a
// narrow header the pills keep their dot and number, their words for screen
// readers only.
import { PanelRight } from "lucide-react";
import type { Ref } from "react";
import { TONE } from "@/components/fleet/FleetList";
import { PageStrip } from "@/components/page";
import { GROUPS, type Group } from "@/fleet/overview";
import { cn } from "@/lib/utils";

export const PILL_WORDS: Record<Group, string> = {
  blocked: "blocked",
  you: "waiting for you",
  running: "in progress",
  ready: "ready to merge",
  merged: "merged today",
};

/** The header's pills: each state that holds an agent, in the states' order. */
export const headerPills = (counts: Record<Group, number>) =>
  GROUPS.filter((group) => counts[group] > 0).map((group) => ({ group, n: counts[group] }));

/** A reading fresher than this says nothing: only a provider read long ago is named. */
const FRESH_MS = 180_000;
const PROVIDER: Record<string, string> = { linear: "Linear", github: "GitHub" };

/** Each provider read long ago: "Linear 25 min ago". */
export function staleReadings(readAt: Readonly<Record<string, string>> | undefined, now: number) {
  return Object.entries(readAt ?? {}).flatMap(([provider, at]) => {
    const age = now - Date.parse(at);
    if (!(age > FRESH_MS)) return [];
    return [{ provider, at, text: `${PROVIDER[provider] ?? provider} ${Math.floor(age / 60_000)} min ago` }];
  });
}

export function Header({
  project,
  counts,
  readAt,
  now,
  open,
  panel,
  toggle,
  onToggle,
  onPill,
}: {
  project: { name: string; repository: string };
  /** The folded counts; none while the project's log is read. */
  counts: Record<Group, number> | null;
  readAt: Readonly<Record<string, string>> | undefined;
  now: number;
  open: boolean;
  /** The panel's id, which the toggle controls. */
  panel: string;
  /** The toggle: the focus comes back to it when the panel leaves with it. */
  toggle?: Ref<HTMLButtonElement>;
  onToggle: () => void;
  onPill: (group: Group) => void;
}) {
  const pills = counts ? headerPills(counts) : [];
  return (
    <PageStrip
      title={project.name}
      end={
        <>
          {pills.length > 0 && (
            <ul aria-label="The project's agents" className="m-0 flex list-none items-center gap-1.5 p-0">
              {pills.map(({ group, n }) => (
                <li key={group}>
                  <button
                    type="button"
                    data-pill={group}
                    // A press keeps the focus where it was (the owner's field): the panel opens beside it.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPill(group)}
                    className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full bg-fill px-2 text-body text-text-2 shadow-ring transition-colors hover:bg-fill-2 hover:text-text @max-[900px]/strip:px-1.5"
                  >
                    <span aria-hidden className={cn("size-1.75 flex-none rounded-full", TONE[group].bg)} />
                    <span className="font-medium font-mono text-meta text-text tnum">{n}</span>{" "}
                    <span className="@max-[900px]/strip:sr-only">{PILL_WORDS[group]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {staleReadings(readAt, now).map((r) => (
            <span
              key={r.provider}
              title={`${PROVIDER[r.provider] ?? r.provider} last read at ${r.at}`}
              className="ml-1.5 text-body text-text-3 @max-[640px]/strip:hidden"
              data-reading={r.provider}
            >
              {r.text}
            </span>
          ))}
          <button
            ref={toggle}
            type="button"
            onClick={onToggle}
            aria-pressed={open}
            aria-controls={open ? panel : undefined}
            aria-label="Panel"
            title="Panel (⌘.)"
            className="ml-1 inline-flex size-7 cursor-pointer items-center justify-center rounded-sm text-text-3 transition-colors hover:bg-fill hover:text-text aria-pressed:text-text"
          >
            <PanelRight aria-hidden size={16} strokeWidth={1.75} />
          </button>
        </>
      }
    >
      <span className="min-w-0 truncate font-mono text-meta text-text-3">{project.repository}</span>
    </PageStrip>
  );
}
