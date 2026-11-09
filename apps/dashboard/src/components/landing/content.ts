// What the landing says that the code decides (THE-887, restored from
// armada-v1-final by #564 and brought to Armada v2). test/landing.test.ts holds
// each of these to its source: the CLI's help, the README's install line, the
// GitHub token's lifetime and the vault's cipher.
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

/** Three commands from a terminal to a running agent. */
export const SETUP: { command: string; note: string }[] = [
  { command: INSTALL, note: "Node 18 or later" },
  { command: "armada login", note: "Sign in in the browser, or by email" },
  {
    command: 'armada launch widgets --agent codex "Fix the flaky test"',
    note: "After armada creds set and armada golden create",
  },
];

/** Every command of `armada --help`, grouped, with what it is for in a few words. */
export const COMMANDS: { name: string; role: "sandbox" | "golden" | "account"; what: string }[] = [
  { name: "launch", role: "sandbox", what: "Fork a golden into a sandbox with Claude Code or Codex" },
  { name: "list", role: "sandbox", what: "Your sandboxes, by status, agent, golden or owner" },
  { name: "detail", role: "sandbox", what: "A sandbox and its latest turn, read fresh" },
  { name: "status", role: "sandbox", what: "Where a sandbox and its latest turn are" },
  { name: "wait", role: "sandbox", what: "Wait until the running turn settles" },
  { name: "send", role: "sandbox", what: "Give the agent its next prompt" },
  { name: "steer", role: "sandbox", what: "Redirect the turn that is running" },
  { name: "interrupt", role: "sandbox", what: "Stop the running turn; the sandbox stays up" },
  { name: "exec", role: "sandbox", what: "Run a command in the sandbox" },
  { name: "logs", role: "sandbox", what: "Read the agent's events, or follow them" },
  { name: "stop", role: "sandbox", what: "Stop the sandbox" },
  { name: "golden create", role: "golden", what: "Clone, set up, scan and snapshot your repositories" },
  { name: "golden update", role: "golden", what: "Rebuild a golden in place" },
  { name: "golden build-status", role: "golden", what: "Read a build job" },
  { name: "golden connect", role: "golden", what: "Open a golden's master for maintenance" },
  { name: "golden snapshot", role: "golden", what: "Scan and freeze the master" },
  { name: "golden capabilities", role: "golden", what: "Golden capacity on each provider" },
  { name: "golden list", role: "golden", what: "The goldens you can see" },
  { name: "golden remove", role: "golden", what: "Take a golden out of launch; its sandboxes and history stay" },
  { name: "golden visibility", role: "golden", what: "Share a golden with your org, or keep it private" },
  { name: "login", role: "account", what: "Sign this terminal in" },
  { name: "logout", role: "account", what: "Sign this terminal out" },
  { name: "account", role: "account", what: "Who you are; revoke this login" },
  { name: "token", role: "account", what: "API tokens for scripts and CI" },
  { name: "org", role: "account", what: "Organizations, their members and roles" },
  { name: "github", role: "account", what: "Connect GitHub, install the App" },
  { name: "creds", role: "account", what: "Store an agent's key, encrypted; list kinds, never values" },
  { name: "mcp", role: "account", what: "MCP servers your sandboxes may use" },
];

/** How long the GitHub token a sandbox gets lasts (the GitHub App's user token), and the vault's cipher. */
export const GITHUB_TOKEN_HOURS = 8;
export const CIPHER = "AES-256-GCM";
