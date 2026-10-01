// The inbox kinds the dashboard writes, apart from `live.ts`: the dashboard's
// client components read them (`activity.ts`), and `live.ts` imports
// `node:crypto`, which the browser bundle would carry as a polyfill (THE-892).

/** The inbox kinds the dashboard writes. */
export type RequestKind = "answer-request" | "launch-request" | "merge-request" | "release-request" | "plan-changes";
export const REQUEST_KINDS: readonly RequestKind[] = [
  "answer-request",
  "launch-request",
  "merge-request",
  "release-request",
  "plan-changes",
];
