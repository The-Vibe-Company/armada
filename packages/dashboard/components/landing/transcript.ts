// Written by `bun run landing` (scripts/landing.ts) from Armada's own code: do not edit.
import type { TerminalCommand } from "./terminal-types";

export const TRANSCRIPT: TerminalCommand[] = [
  {
    command: "armada status",
    output:
      "Widgets · WID-1 Widgets roadmap\nRead 2026-10-01 13:42 UTC · Linear WID-1 · GitHub acme/widgets\n\nIn flight (5)\n  WID-18  ready-to-merge  Claude Code · Worker B · reported 6 min ago\n          Add a dark theme to the settings page [Spec 1]\n          “Handed back: CI green on the final head”\n          PR #44 · CI success · mergeable\n  WID-14  shipping · ci   Conductor · Worker C · reported 4 min ago\n          Show the invoice total on the order page [Spec 1]\n          “Fixing the rounding test that fails in CI”\n          PR #41 · CI failure · mergeable\n          ! ci-failing\n  WID-12  implementing    Claude Code · Worker D · reported 3 min ago\n          Let users export a report as CSV [Spec 1]\n          “Streaming rows instead of building the file in memory”\n  WID-17  implementing    Codex · Worker E · reported 42 min ago\n          Retry failed webhook deliveries [Spec 1]\n          “Backoff schedule written, wiring the queue”\n          ! silent\n  WID-15  blocked         Conductor · Worker A · reported 12 min ago\n          Sign in with a magic link [Spec 1]\n          “Asked how long a sign-in link stays valid”\n\nReady to start (3)\n  WID-20  Let users change their email address  (Spec 1)\n  WID-21  Rate-limit the public API  (Spec 1)\n  WID-22  Fix: refunds round the total the wrong way  (Spec 1)\n\nUnblocked but not marked ready (1)\n  WID-23  Archive invoices older than a year\n\nPull requests waiting (2)\n  #41     WID-14 shipping · ci · CI failure · mergeable\n          Show the invoice total on the order page\n          ! failing: Lint, typecheck and test, Build\n  #44     WID-18 ready-to-merge · CI success · mergeable\n          Add a dark theme to the settings page",
  },
  {
    command: "armada watch",
    output:
      "Inbox of widgets (3), oldest first:\n  silent · WID-17 · from ws-90aa/ses-33 · 2026-10-01T13:00:00.000Z\n    no report for 42 min (phase implementing, Codex ws-90aa/ses-33); check it with the runtime guide's status section\n  #12 question · WID-15 · from Worker A · 2026-10-01T13:30:00.000Z\n    How long should a sign-in link stay valid?\n    Shorter is safer; longer survives a slow mail server.\n\n    Options:\n    1. 15 minutes (recommended)\n    2. 30 minutes\n* #13 hand-back · WID-18 · from Worker B · 2026-10-01T13:36:00.000Z\n    PR #44 is ready: head a3f9c2e, CI green.\n    shipping path unreported\nFor herdr, armada answer delivers automatically. Deliver each other answer in the worker's session with the runtime guide, then record it: armada answer <id> \"<answer>\".\nNew items are marked *.\n5 workers in flight (WID-15, WID-18, WID-14, WID-12, WID-17) — act on the items above, then keep watching: armada watch",
  },
];
