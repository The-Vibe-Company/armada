// Written by `bun apps/dashboard/scripts/landing-transcript.ts` from the Armada CLI's own code: do not edit.
import type { TerminalCommand } from "./terminal-types";

export const TRANSCRIPT: TerminalCommand[] = [
  {
    command: "armada golden list",
    output: "widgets  boat  org  snapshot  2 repos\ngadgets  modal  org  snapshot  1 repo",
  },
  {
    command: 'armada launch widgets --agent codex "Fix the flaky checkout test in widgets" --ttl 4h',
    output:
      "Launched codex sandbox from golden widgets.\nAccess: enforced by the server; metadata hints do not grant interior access.\nSandbox: 6f1c2a9e-4b7d-4e2a-9c51-3d8e0f7a2b14\nBoat sandbox: bx_7k2m9q\nStatus: running\nModel: gpt-6.1-sol (reasoning effort medium)\nConversation: conversation-1\nGitHub: git and gh act as lea-acme (launch token expires at 2026-11-09T17:30:00.000Z (~480 minutes remaining); shared owner refresh may invalidate it earlier). Use armada github refresh 6f1c2a9e-4b7d-4e2a-9c51-3d8e0f7a2b14 for a running legacy sandbox; automatic next-prompt repair is experimental and off by default.\nStops by itself at 2026-11-09T13:30:00.000Z (TTL 14400s).",
  },
  {
    command: "armada logs 6f1c2a9e-4b7d-4e2a-9c51-3d8e0f7a2b14",
    output:
      "Fix the flaky checkout test in widgets\nThe checkout test reads the clock twice; it fails when a second ticks between the two reads.\nI pass one fixed time through the test instead. 214 tests pass, ten runs in a row.\nPushed fix/checkout-clock and opened pull request #52.",
  },
];
