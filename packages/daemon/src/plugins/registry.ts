import { type PluginManifest, type PluginRegister, type Providers, SEAMS, type Seam } from "@armada/plugin-api";

/** Providers are published atomically after activate; consumers can only read. */
export class PluginRegistry {
  readonly #providers = new Map<Seam, Map<string, unknown>>(SEAMS.map((seam) => [seam, new Map()]));

  readonly #projects = new Map<string, PluginRegistry>();

  setProject(project: string, registry: PluginRegistry): void {
    this.#projects.set(project, registry);
  }
  removeProject(project: string): void {
    this.#projects.delete(project);
  }

  get<S extends Seam>(seam: S, kind: string, project?: string): Providers[S] | undefined {
    if (project && this.#projects.has(project)) {
      const scoped = this.#projects.get(project);
      if (!scoped) return undefined;
      // A disabled/unavailable scoped reader must not fall back to stale boot configuration.
      if (seam === "tracker" || seam === "forge" || seam === "node") return scoped.get(seam, kind);
    }
    return this.#providers.get(seam)?.get(kind) as Providers[S] | undefined;
  }

  activation(manifest: PluginManifest): { register: PluginRegister; commit(): void; abort(): void } {
    const pending = new Map<string, { seam: Seam; kind: string; provider: unknown }>();
    let active = true;
    const register = Object.fromEntries(
      SEAMS.map((seam) => [
        seam,
        (kind: string, provider: unknown) => {
          if (!active) throw new Error("registration is only allowed during activate");
          if (!Object.hasOwn(manifest.contributions[seam] ?? {}, kind))
            throw new Error(`undeclared contribution ${seam}.${kind}`);
          if (this.#providers.get(seam)?.has(kind) || pending.has(`${seam}.${kind}`))
            throw new Error(`duplicate contribution ${seam}.${kind}`);
          if (provider === null || (typeof provider !== "object" && typeof provider !== "function"))
            throw new Error(`invalid provider for ${seam}.${kind}`);
          pending.set(`${seam}.${kind}`, { seam, kind, provider });
        },
      ]),
    ) as PluginRegister;
    return {
      register,
      abort() {
        active = false;
        pending.clear();
      },
      commit: () => {
        if (!active) throw new Error("activation has ended");
        active = false;
        for (const seam of SEAMS)
          for (const kind of Object.keys(manifest.contributions[seam] ?? {}))
            if (!pending.has(`${seam}.${kind}`)) throw new Error(`missing registration ${seam}.${kind}`);
        for (const { seam, kind, provider } of pending.values()) this.#providers.get(seam)?.set(kind, provider);
      },
    };
  }
}
