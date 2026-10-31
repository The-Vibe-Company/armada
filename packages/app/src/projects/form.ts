// The Add project form's rules (THE-2081), pure: the id a name gives, the
// repository the daemon accepts, what the form starts from once the daemon
// inspected a folder, and the inspection's problems in the owner's words.
import { addProjectInputSchema, type ProjectInspection } from "@armada/protocol";

/** The fields the owner confirms. */
export interface ProjectFields {
  repository: string;
  name: string;
  /** The Linear program's root; empty is "Without Linear". */
  program: string;
}

/** A project's id from its name: the daemon's own rule for its suggestion (packages/daemon/src/projects.ts). */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 200)
    .replace(/^-|-$/g, "");
}

/** The id the project is added under: its name's, else the daemon's suggestion (a name of no Latin letter). */
export const idOf = (name: string, inspection: ProjectInspection) => slugOf(name) || inspection.suggested.id;

/** Whether the daemon takes this as a repository: `owner/repo`, the protocol's own check. */
export const isRepository = (value: string) => addProjectInputSchema.shape.repository.safeParse(value).success;

/** Whether the form can be sent: a repository the daemon takes and a name. */
export const ready = (fields: ProjectFields) => isRepository(fields.repository.trim()) && fields.name.trim() !== "";

/** What the form starts from: the repository its remote or armada.toml names, the folder's name, armada.toml's program. */
export function fieldsOf(inspection: ProjectInspection): ProjectFields {
  const { name, repository, programRoot } = inspection.suggested;
  return {
    repository: repository ?? "",
    // The folder's name, as a project's name is written: `armada` reads Armada.
    name: name.charAt(0).toUpperCase() + name.slice(1),
    program: programRoot ?? "",
  };
}

/** The program the daemon adds the project under when the field is empty: armada.toml's, if it names one. */
export const tomlProgram = (inspection: ProjectInspection) => inspection.toml?.programRoot;

/** Whether the folder can be added at all: the daemon refuses a path it cannot open. */
export const readable = (inspection: ProjectInspection) => !inspection.problems.includes(NOT_A_FOLDER);

const NOT_A_FOLDER = "Path is not an accessible folder";
const NO_REMOTE = "Git repository has no readable origin remote";
const NOT_GITHUB = "Git origin is not a supported GitHub repository URL";

/**
 * The inspection's problems for the owner. Without a repository to suggest,
 * a remote's problem says what to do: choose the repository; with one from
 * armada.toml, the daemon's line stays as it is.
 */
export function problemsOf(inspection: ProjectInspection): string[] {
  if (inspection.suggested.repository) return inspection.problems;
  const lines = inspection.problems.map((p) =>
    p === NO_REMOTE
      ? "No git remote: choose the repository"
      : p === NOT_GITHUB
        ? "The git remote is not on GitHub: choose the repository"
        : p,
  );
  const remote = lines.some((l) => l.endsWith("choose the repository"));
  // A folder that is no Git repository says so already; any other folder without a repository is asked for one.
  return remote || inspection.git === null ? lines : [...lines, "No git remote: choose the repository"];
}
