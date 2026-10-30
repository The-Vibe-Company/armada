import type { PluginContext } from "@armada/plugin-api";
import { probe } from "@armada/plugin-api/connection";
import type { Keychain } from "../keychain.ts";

/** The host owns credential precedence and storage; plugins receive declared names only. */
export function connectionSecrets(
  resolver: PluginContext["secrets"],
  keychain: Keychain,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PluginContext["secrets"] {
  return {
    get: (name, project) => resolver.get(name, project),
    set: (name, value) => keychain.write("plugin", name, value),
    delete: (name) => keychain.remove("plugin", name),
    async source(name, project) {
      if (resolver.source) return resolver.source(name, project);
      const value = await resolver.get(name, project);
      if (!value) return null;
      if (value === env[name]?.trim() || (name === "GITHUB_TOKEN" && value === env.GH_TOKEN?.trim()))
        return "Environment";
      if (value === (await keychain.read("plugin", name).catch(() => null))) return "Saved key";
      if (name === "GITHUB_TOKEN") {
        if (value === (await keychain.read("github", "github").catch(() => null))) return "Saved key";
        const gh = await probe("gh", ["auth", "token"]);
        if (gh.ok && value === gh.output) return "gh";
      }
      return "Armada";
    },
  };
}
