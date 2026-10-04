// The formation, used with restraint (THE-899, design/dashboard-v5): the live
// mark (its lead ship brightens on each poll, the formation assembles while
// loading, the lead ship turns amber when a reading failed), the formation
// at rest of an empty state, and the ship of a session's flight path. Server-safe, CSS only: the beat is
// a class the shell's live line re-keys on each poll.
import { MARK } from "./shell/Logo";

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

export type MarkState = "live" | "loading" | "paused";

/** The formation as the live indicator: `beat` restarts the lead ship's glow (a poll landed). */
export function LiveMark({ size = 16, state = "live", beat }: { size?: number; state?: MarkState; beat?: number }) {
  return (
    <svg
      key={beat}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden
      className={cx("ui-mark", `is-${state}`, beat !== undefined && state === "live" && "is-beat")}
    >
      {MARK.map((s, i) => (
        <path
          key={s.d}
          d={s.d}
          className={i === 0 ? "ui-mark-lead" : undefined}
          fill={i === 0 ? undefined : s.fill}
          fillOpacity={s.opacity}
        />
      ))}
    </svg>
  );
}

/** The formation at rest: an empty state's picture, outlines with the lead ship lit. */
export function FormationAtRest({ size = 104 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.85} viewBox="-4 0 40 34" aria-hidden className="ui-rest">
      <defs>
        <radialGradient id="ui-rest-glow" cx="50%" cy="30%" r="50%">
          <stop offset="0" stopColor="var(--done)" stopOpacity="0.22" />
          <stop offset="1" stopColor="var(--done)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="16" cy="9" r="11" fill="url(#ui-rest-glow)" />
      {MARK.map((s, i) =>
        i === 0 ? (
          <path key={s.d} d={s.d} fill="var(--done)" fillOpacity={0.9} />
        ) : (
          <path
            key={s.d}
            d={s.d}
            fill="none"
            stroke="var(--text)"
            strokeOpacity={i < 3 ? 0.55 : 0.28}
            strokeWidth={0.7}
            strokeLinejoin="round"
          />
        ),
      )}
      <path d="M-2 32.5H34" stroke="var(--text)" strokeOpacity={0.08} strokeWidth={0.5} />
    </svg>
  );
}

/** A ship pointing right, in a color: a live session's head at "now", a merge leaving the formation. */
export function Ship({ color, size = 11, className }: { color: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className={className}>
      <path d="M11.5 6L1 11V1Z" fill={color} />
    </svg>
  );
}
