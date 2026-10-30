// The one bridge between the app's window and the shell (THE-2055): the app's
// notifications bring the window forward on a click, and keep the dock's
// badge at the count not yet read. The preload exposes it as
// `window.armadaShell` (packages/app/src/notify/shell.ts); the main process
// answers only the app's own window.

export const REVEAL_CHANNEL = "armada:reveal";
export const BADGE_CHANNEL = "armada:badge";
/** Past this the dock's badge says no more. */
export const BADGE_MAX = 99;

/** The badge a renderer's value asks for: a whole count from 0 to BADGE_MAX, anything else clears it. */
export function badgeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, BADGE_MAX) : 0;
}
