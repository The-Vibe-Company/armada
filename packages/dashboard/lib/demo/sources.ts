// Demo mode (ARMADA_DASHBOARD_DEMO=fleet|empty): Linear and GitHub are replaced
// by the synthetic world in ./world; Turso stays real, usually a local
// `file:` database seeded with `bun run demo:seed`. No key is needed.
import { configTemplate, parseConfig } from "@armada/core/read";
import type { Sources } from "../fleet-data";
import { DEMO_PROJECTS, demoSnapshot, type Scenario } from "./world";

export function demoSources(mode: string, real: Sources): Sources {
  const scenario: Scenario = mode === "empty" ? "empty" : "fleet";
  const find = (repository: string) => {
    const p = DEMO_PROJECTS.find((d) => d.repository === repository);
    if (!p) throw new Error(`${repository} is not a demo project`);
    return p;
  };
  return {
    openLive: real.openLive,
    fallbackProjects: () => {
      const fromEnv = real.fallbackProjects();
      return fromEnv.length ? fromEnv : DEMO_PROJECTS.map((p) => ({ repository: p.repository }));
    },
    readConfig: async (p) => ({ config: parseConfig(configTemplate(find(p.repository))), warning: null }),
    readSnapshot: async (config) => {
      const { program, forge } = demoSnapshot(find(config.github.repository), scenario, new Date());
      return { program, forge, forgeError: null };
    },
  };
}
