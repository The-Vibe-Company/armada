import { join } from "node:path";

/** Real Git tests must not consult the developer's helpers, config, or tool wrappers. */
export function isolatedGitEnvironment(home: string): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
}
