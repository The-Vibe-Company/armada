// What the landing says that the code decides (THE-887). test/landing.test.ts
// holds each of these to its source: the CLI's help, the launch token's
// lifetime, the vault's cipher and the README's install lines.
import cli from "../../../cli/package.json" with { type: "json" };

export const REPOSITORY = "https://github.com/The-Vibe-Company/armada";
export const RELEASES = `${REPOSITORY}/releases`;
export const DOCS = `${REPOSITORY}#readme`;
export const COMPANY = "https://thevibecompany.co";
export const SITE = "https://armada.thevibecompany.co";

/** The CLI release the landing was built with: the deploy follows each release. */
export const VERSION = cli.version;
export const RELEASE = `${RELEASES}/tag/v${cli.version}`;

export const INSTALL = "npm install -g @the-vibe-company/armada";

/** Three commands from a repository to a fleet, as the README sets one up. */
export const SETUP: { command: string; note: string }[] = [
  { command: INSTALL, note: "Node 22 or later" },
  { command: "armada login", note: "Approve the code in the browser" },
  { command: "armada init --program-root ABC-1", note: "One pull request adds what the repository lacks" },
];

/** Every command of `armada --help`, in its order, with what it is for in a few words. */
export const COMMANDS: { name: string; role: "both" | "coordinator" | "worker" | "you"; what: string }[] = [
  { name: "coordinator", role: "coordinator", what: "Choose a named role, list coordinators and take over tickets" },
  { name: "attach", role: "worker", what: "Attach screenshots and links for the owner to check" },
  { name: "heartbeat", role: "worker", what: "Keep a worker's session alive in the background" },
  { name: "spec", role: "coordinator", what: "Add a spec or preview and apply title repairs" },
  { name: "status", role: "both", what: "Tickets in flight, ready to start, pull requests waiting" },
  {
    name: "setup",
    role: "you",
    what: "Set up local harnesses, choose permissions and answer their first-run questions",
  },
  { name: "doctor", role: "you", what: "What the repository lacks, with the fix for each" },
  { name: "init", role: "you", what: "One pull request that sets the repository up" },
  { name: "skills", role: "you", what: "Update the bundled skills on the current branch" },
  { name: "claim", role: "worker", what: "Take a ticket: In Progress, phase planning" },
  { name: "report", role: "worker", what: "Report a phase; the same phase again is a heartbeat" },
  { name: "release", role: "worker", what: "Give the ticket back" },
  { name: "ask", role: "worker", what: "Ask the coordinator, then wait for the answer" },
  { name: "validate", role: "both", what: "Show the owner a design or a change, then wait" },
  { name: "ask-owner", role: "coordinator", what: "Escalate a question to the owner, with its choices" },
  { name: "done", role: "coordinator", what: "Close a design ticket the owner approved" },
  { name: "inbox", role: "coordinator", what: "Questions, plans, requests, hand-backs, silent workers" },
  { name: "watch", role: "coordinator", what: "Wait in the background until something needs you" },
  { name: "stop", role: "coordinator", what: "Stop a local worker after its work is pushed" },
  { name: "answer", role: "coordinator", what: "Deliver local worker answers and record decisions" },
  { name: "merge", role: "coordinator", what: "Check a hand-back and squash-merge it, pinned to its SHA" },
  { name: "launch", role: "coordinator", what: "Launch a local worker or revoke an unclaimed launch" },
  { name: "brief", role: "coordinator", what: "A worker's launch prompt, with a one-time token" },
  { name: "secrets", role: "both", what: "The project's secrets for workers, never shown" },
  { name: "run", role: "worker", what: "Run a command with those secrets in its environment" },
  { name: "hook", role: "coordinator", what: "Claude Code's Stop hook: keep watching while workers fly" },
  { name: "login", role: "both", what: "Sign this terminal in to Armada" },
  { name: "whoami", role: "both", what: "Who this terminal is signed in as" },
  { name: "logout", role: "both", what: "Sign this terminal out" },
  { name: "auth", role: "you", what: "Keys on this machine, for an Armada without accounts" },
];

/** The launch token's lifetime and the vault's cipher, as lib/workers.ts and lib/vault.ts set them. */
export const LAUNCH_TOKEN_HOURS = 1;
export const CIPHER = "AES-256-GCM";
