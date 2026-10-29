import { HARNESS_LABEL, type Harness } from "@/fleet/sky";
import { HARNESS_COLOR } from "@/sky/layout";

/** The mark's triangle, an agent as the sky draws it: its harness's colour, bone for another runtime or a merge. */
export function Ship({
  harness,
  merged = false,
  size = 12,
}: {
  harness: Harness | null;
  merged?: boolean;
  size?: number;
}) {
  const known = harness && !merged;
  return (
    <svg width={size} height={size} viewBox="-6 -6 12 12" aria-hidden className="block flex-none">
      <path
        d="M0 -6 L5.2 5 L-5.2 5 Z"
        fill={known ? HARNESS_COLOR[harness] : "#e6e7e9"}
        fillOpacity={known ? 1 : 0.6}
      />
    </svg>
  );
}

/** The harness's name beside its triangle. */
export function HarnessName({ harness }: { harness: Harness }) {
  return (
    <span className="inline-flex flex-none items-center gap-1.5">
      <Ship harness={harness} size={10} />
      {HARNESS_LABEL[harness]}
    </span>
  );
}
