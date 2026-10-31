import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { type AddProjectInput, addProjectInputSchema, type ProjectInspection } from "@armada/protocol";
import { z } from "zod";
import { parseConfig } from "../../core/src/config.ts";
import { daemonProjectSchema } from "./server/readers.ts";

export type DaemonProject = z.infer<typeof daemonProjectSchema>;
export class ProjectRefusal extends Error {}
export class ProjectRecoveryError extends ProjectRefusal {}
const execute = promisify(execFile);
const git = async (path: string, ...args: string[]) =>
  (
    await execute("git", ["--no-optional-locks", "-C", path, ...args], {
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    })
  ).stdout.trim();
function repositoryOf(remote: string): string | undefined {
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      remote,
    );
  return match?.[1];
}
async function tomlAt(path: string, problems: string[]): Promise<ProjectInspection["toml"]> {
  let body: string;
  try {
    body = await fs.readFile(resolve(path, "armada.toml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push("Could not read armada.toml");
    return null;
  }
  try {
    const config = parseConfig(body);
    return {
      programRoot: config.tracker.programRoot,
      phaseGroup: config.tracker.labels.phaseGroup,
      runtimeGroup: config.tracker.labels.runtimeGroup,
      readyLabel: config.tracker.readyLabel,
      repository: config.github.repository,
    };
  } catch {
    problems.push("armada.toml is invalid; check its project, tracker and GitHub settings");
    return null;
  }
}
export async function inspectProject(input: string): Promise<ProjectInspection> {
  const path = resolve(input);
  const name = basename(path) || "Project";
  const result: ProjectInspection = {
    path,
    git: null,
    toml: null,
    suggested: {
      id:
        name
          .toLowerCase()
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 200)
          .replace(/^-|-$/g, "") || "project",
      name,
    },
    problems: [],
  };
  try {
    if (!(await fs.stat(path)).isDirectory()) throw new Error();
  } catch {
    result.problems.push("Path is not an accessible folder");
    return result;
  }
  try {
    await git(path, "rev-parse", "--show-toplevel");
    const [branch, status] = await Promise.all([
      git(path, "rev-parse", "--abbrev-ref", "HEAD").catch(() => undefined),
      git(path, "status", "--porcelain"),
    ]);
    result.git = { ...(branch ? { branch } : {}), clean: !status };
    try {
      const remote = repositoryOf(await git(path, "remote", "get-url", "origin"));
      if (remote) result.git.remote = remote;
      else result.problems.push("Git origin is not a supported GitHub repository URL");
    } catch {
      result.problems.push("Git repository has no readable origin remote");
    }
  } catch {
    result.problems.push("Folder is not a readable Git repository");
  }
  result.toml = await tomlAt(path, result.problems);
  const repository = result.git?.remote ?? result.toml?.repository;
  if (repository) result.suggested.repository = repository;
  if (result.toml?.programRoot) result.suggested.programRoot = result.toml.programRoot;
  return result;
}
export interface ProjectLifecycle {
  start(project: DaemonProject): Promise<void>;
  stop(project: DaemonProject): Promise<void>;
  /** Shares the worker launch queue: the guard and commit are one exclusive operation. */
  removing?<T>(project: string, action: () => Promise<T>): Promise<T>;
}

/** The daemon is the only writer. Mutations settle services and commit one atomic file replacement. */
export class Projects {
  readonly #path: string;
  readonly #lifecycle: ProjectLifecycle;
  #list: DaemonProject[];
  #queue: Promise<unknown> = Promise.resolve();
  #closing = false;
  #recovery: ProjectRecoveryError | undefined;
  readonly #listeners = new Set<() => void>();
  private constructor(path: string, list: DaemonProject[], lifecycle: ProjectLifecycle) {
    this.#path = path;
    this.#list = list;
    this.#lifecycle = lifecycle;
  }
  static async open(path: string, lifecycle: ProjectLifecycle): Promise<Projects> {
    let values: unknown;
    try {
      values = JSON.parse(await fs.readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      values = [];
    }
    const list = z.array(daemonProjectSchema).parse(values);
    if (new Set(list.map((p) => p.id)).size !== list.length) throw new ProjectRefusal("Duplicate project id");
    const roots = new Set<string>();
    for (const project of list) {
      if (project.root || project.checkout) {
        const root = project.root ?? project.checkout;
        if (!root) continue;
        project.root = await fs.realpath(root);
        project.checkout = project.root;
        if (roots.has(project.root)) throw new ProjectRefusal("Duplicate project root");
        roots.add(project.root);
      }
    }
    return new Projects(resolve(path), list, lifecycle);
  }
  get list(): readonly DaemonProject[] {
    return this.#list.map((p) => ({ ...p }));
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #publish() {
    for (const listener of this.#listeners) listener();
  }
  async close(): Promise<void> {
    this.#closing = true;
    await this.#queue.catch(() => {});
  }
  #serial<T>(action: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new ProjectRefusal("Project registry is stopping"));
    const next = this.#queue
      .catch(() => {})
      .then(() => {
        if (this.#recovery) throw this.#recovery;
        return action();
      });
    this.#queue = next;
    return next;
  }
  #unavailable(): ProjectRecoveryError {
    this.#recovery ??= new ProjectRecoveryError(
      "The projects file is unchanged, but project services could not be restored. Project changes are paused; restart the daemon to recover.",
    );
    return this.#recovery;
  }
  async #save(list: DaemonProject[]) {
    await fs.mkdir(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, this.#path);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
  add(input: AddProjectInput): Promise<readonly DaemonProject[]> {
    return this.#serial(async () => {
      const parsed = addProjectInputSchema.safeParse(input);
      if (!parsed.success)
        throw new ProjectRefusal("Invalid project id, name, path or repository (expected owner/repo)");
      const data = parsed.data;
      if (this.#list.some((p) => p.id === data.id)) throw new ProjectRefusal("Project id already exists");
      let root: string;
      try {
        root = await fs.realpath(data.path);
        if (!(await fs.stat(root)).isDirectory()) throw new Error();
      } catch {
        throw new ProjectRefusal("Project path is not an accessible folder");
      }
      if (this.#list.some((p) => p.root === root)) throw new ProjectRefusal("Project root is already registered");
      const toml = await tomlAt(root, []);
      const programRoot = data.programRoot ?? toml?.programRoot;
      const project = daemonProjectSchema.parse({
        id: data.id,
        name: data.name,
        repository: data.repository,
        root,
        checkout: root,
        ...(programRoot === undefined ? {} : { programRoot }),
        phaseGroup: data.phaseGroup ?? toml?.phaseGroup ?? "Agent phase",
        ...(toml?.readyLabel === undefined ? {} : { readyLabel: toml.readyLabel }),
        ...(toml?.runtimeGroup === undefined ? {} : { runtimeGroup: toml.runtimeGroup }),
      });
      try {
        await this.#lifecycle.start(project);
        await this.#save([...this.#list, project]);
      } catch (error) {
        try {
          await this.#lifecycle.stop(project);
        } catch {
          throw this.#unavailable();
        }
        throw error;
      }
      this.#list = [...this.#list, project];
      this.#publish();
      return this.list;
    });
  }
  remove(id: string): Promise<readonly DaemonProject[]> {
    return this.#serial(async () => {
      const project = this.#list.find((p) => p.id === id);
      if (!project) throw new ProjectRefusal("No such project");
      const action = async () => {
        const next = this.#list.filter((p) => p.id !== id);
        try {
          await this.#lifecycle.stop(project);
          await this.#save(next);
        } catch (error) {
          try {
            await this.#lifecycle.start(project);
          } catch {
            // A failed restart may have partially opened readers or a coordinator.
            await this.#lifecycle.stop(project).catch(() => {});
            throw this.#unavailable();
          }
          throw error;
        }
        this.#list = next;
        this.#publish();
        return this.list;
      };
      return this.#lifecycle.removing ? this.#lifecycle.removing(id, action) : action();
    });
  }
}
