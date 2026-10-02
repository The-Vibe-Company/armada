// The sections' line icons (THE-899, design/dashboard-v5): one shape per
// section, drawn on a 16 px grid at 1.5 px, in the text's color. The sidebar
// and the phone's tab bar use them.
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
    case "organization":
      return (
        <>
          <rect x="2" y="2" width="5" height="5" rx="1.5" />
          <rect x="9" y="2" width="5" height="5" rx="1.5" />
          <rect x="2" y="9" width="5" height="5" rx="1.5" />
          <rect x="9" y="9" width="5" height="5" rx="1.5" />
        </>
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

/** The organization menu's chevron. */
export function ChevronIcon() {
  return (
    <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden {...STROKE} strokeWidth={1.4} strokeLinecap="round">
      <path d="M3 4.5l3 3 3-3" />
    </svg>
  );
}
