// What the landing says that the code decides (THE-887, restored from
// armada-v1-final by #564, retold by #587). test/landing.test.ts holds each of
// these to its source: the CLI's help, the README's install line, the GitHub
// token's lifetime and the vault's cipher.
import { VERSION as CORE_VERSION } from "@armada/core";

export const REPOSITORY = "https://github.com/The-Vibe-Company/armada";
export const RELEASES = `${REPOSITORY}/releases`;
export const DOCS = `${REPOSITORY}#readme`;
export const COMPANY = "https://thevibecompany.co";
export const SITE = "https://armada.thevibecompany.co";

/** The release the landing was built with (one version for every package): the deploy follows each release. */
export const VERSION = CORE_VERSION;
export const RELEASE = `${RELEASES}/tag/v${VERSION}`;
/** Where "Read the setup guide" goes: the README's install section (v1's `#set-up` is gone). */
export const SETUP_GUIDE = `${REPOSITORY}#install`;

export const INSTALL = "npm install -g @the-vibe-company/armada";

/** The CLI line under each chapter of the story: every command and flag is one `armada --help` documents. */
export const STORY = {
  golden: "armada golden create widgets --repo https://github.com/acme/widgets --provider modal",
  launch: 'armada launch widgets --agent claude --model claude-opus-5-5 --reasoning-effort high "Add a dark theme"',
  tools: "armada mcp add docs https://mcp.example.com/mcp --scope org",
  resume: 'armada send 6f1c2a9e-4b7d-4e2a-9c51-3d8e0f7a2b14 "Now cover the empty cart"',
  keys: "armada creds set codex-auth --file ~/.codex/auth.json",
  watch: "armada logs 6f1c2a9e-4b7d-4e2a-9c51-3d8e0f7a2b14 --follow",
} as const;

/** The CLI path to a first agent, in order, after the sign-in prerequisites the page states. */
export const SETUP: { command: string; note: string }[] = [
  { command: INSTALL, note: "Node 18 or later" },
  { command: "armada login", note: "Sign in through the browser, or by email" },
  { command: STORY.keys, note: "Your agent's key, from a file, never an argument" },
  {
    command: "armada golden create widgets --repo https://github.com/acme/widgets",
    note: "GitHub connected; --provider boat or modal picks where it is built",
  },
  { command: 'armada launch widgets --agent codex "Fix the flaky checkout test"', note: "Your first agent" },
];

/** How long the GitHub token a sandbox gets lasts (the GitHub App's user token), and the vault's cipher. */
export const GITHUB_TOKEN_HOURS = 8;
export const CIPHER = "AES-256-GCM";
