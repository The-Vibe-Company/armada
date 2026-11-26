import type { TerminalCommand } from "./terminal-types";

export const TRANSCRIPT: TerminalCommand[] = [
  {
    command: "armada snapshot ls",
    output: "widgets  boat  org  snapshot  2 repos\ngadgets  modal  org  snapshot  1 repo",
  },
  {
    command: 'armada new widgets --provider boat --agent codex "Fix the flaky checkout test in widgets" --ttl 4h',
    output:
      'Launched codex sandbox from snapshot widgets.\nAccess: enforced by the server; metadata hints do not grant interior access.\nSandbox: 6f1c2a9e-4b7d-4e2a-9c51-3d8e0f7a2b14\nBoat sandbox: bx_7k2m9q\nStatus: running\nModel: gpt-6.2-sol (reasoning effort medium)\nConversation: conversation-1\nGitHub: git and gh act as lea-acme (launch token expires at 2026-11-09T17:30:00.000Z (~480 minutes remaining); shared owner refresh may invalidate it earlier). Refresh with armada api github/refresh \'{"id":"6f1c2a9e-4b7d-4e2a-9c51-3d8e0f7a2b14"}\'.\nStops by itself at 2026-11-09T13:30:00.000Z (TTL 14400s).',
  },
  {
    command: "armada events 6f1c2a9e-4b7d-4e2a-9c51-3d8e0f7a2b14",
    output:
      "Fix the flaky checkout test in widgets\nThe checkout test reads the clock twice; it fails when a second ticks between the two reads.\nI pass one fixed time through the test instead. 214 tests pass, ten runs in a row.\nPushed fix/checkout-clock and opened pull request #52.",
  },
];
