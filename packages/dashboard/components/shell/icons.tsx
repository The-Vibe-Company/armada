// The sections' line icons (THE-899, design/dashboard-v5): one shape per
// section, drawn on a 16 px grid at 1.5 px, in the text's color. The sidebar,
// the phone's tab bar and the saved views use them.
import type { Section } from "@/lib/fleet-view";

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.5 } as const;

function Shape({ section }: { section: NonNullable<Section> }) {
  switch (section) {
    case "overview":
      return (
        <>
          <rect x="2" y="2" width="12" height="12" rx="3" />
          <path d="M2 9.5h12" />
        </>
      );
    case "validations":
      return (
        <>
          <path d="M8 1.6L14.4 8 8 14.4 1.6 8Z" strokeLinejoin="round" />
          <path d="M5.6 8.1l1.6 1.6 3.2-3.3" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "projects":
      return (
        <>
          <rect x="2" y="2" width="5" height="5" rx="1.5" />
          <rect x="9" y="2" width="5" height="5" rx="1.5" />
          <rect x="2" y="9" width="5" height="5" rx="1.5" />
          <rect x="9" y="9" width="5" height="5" rx="1.5" />
        </>
      );
    case "agents":
      return (
        <g strokeLinejoin="round">
          <path d="M8 2.5L11 8H5Z" />
          <path d="M4 9.5L6.5 14h-5Z" />
          <path d="M12 9.5L14.5 14h-5Z" />
        </g>
      );
    case "insights":
      return <path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" strokeLinecap="round" />;
    case "activity":
      return (
        <>
          <path d="M4.5 3.5h9M4.5 8h9M4.5 12.5h9" strokeLinecap="round" />
          <circle cx="2" cy="3.5" r="0.6" fill="currentColor" />
          <circle cx="2" cy="8" r="0.6" fill="currentColor" />
          <circle cx="2" cy="12.5" r="0.6" fill="currentColor" />
        </>
      );
  }
}

export function SectionIcon({ section, size = 16 }: { section: NonNullable<Section>; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="sh-icon" {...STROKE}>
      <Shape section={section} />
    </svg>
  );
}

/** The phone's back arrow, to the page a detail page belongs to. */
export function BackIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 16 16"
      aria-hidden
      {...STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 3L5 8l5 5" />
    </svg>
  );
}

/** The organization menu's chevron. */
export function ChevronIcon() {
  return (
    <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden {...STROKE} strokeWidth={1.4} strokeLinecap="round">
      <path d="M3 4.5l3 3 3-3" />
    </svg>
  );
}
