// Pure path comparison, shared by plan reports and future post-merge notices.
export interface OverlapWorker {
  ticket: string;
  pr: number | null;
  files: string[] | null;
  filesComplete: boolean;
  plan: string[];
}

export interface Overlap {
  ticket: string;
  pr: number | null;
  /** Candidate declarations that touch the other worker's files or plan. */
  paths: string[];
  incomplete: boolean;
}

export interface OverlapReading {
  workers: OverlapWorker[];
  overlaps: Overlap[];
  /** No stored snapshot/forge reading: declarations are still compared. */
  incomplete: boolean;
}

/** Repository paths only; shared by the CLI and API before any writes. */
export function pathsProblem(paths: unknown): string | null {
  if (!Array.isArray(paths) || paths.length > 50) return "paths must be an array of at most 50 paths";
  for (const path of paths)
    if (
      typeof path !== "string" ||
      !path.trim() ||
      path.length > 200 ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      path.split("/").includes("..")
    )
      return "each path must be relative, at most 200 characters, without .. or control characters";
  return null;
}

/** *, ** and ? only: a single wildcard never crosses a directory separator. */
export function globToRegExp(glob: string): RegExp {
  let pattern = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        pattern += "(?:.*/)?";
        i++;
      } else pattern += ".*";
    } else if (c === "*") pattern += "[^/]*";
    else if (c === "?") pattern += "[^/]";
    else pattern += c?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${pattern}$`);
}

const isGlob = (path: string) => /[*?]/.test(path);
const prefix = (path: string) => path.split(/[*?]/, 1)[0] ?? "";
function touches(a: string, b: string): boolean {
  if (isGlob(a) && isGlob(b)) return prefix(a).startsWith(prefix(b)) || prefix(b).startsWith(prefix(a));
  if (isGlob(a)) return globToRegExp(a).test(b);
  if (isGlob(b)) return globToRegExp(b).test(a);
  return a === b;
}

/** Glob/glob comparisons are conservative: matching static prefixes may overlap. */
export function overlaps(candidate: string[], others: OverlapWorker[]): Overlap[] {
  return others.flatMap((other) => {
    const known = [...(other.files ?? []), ...other.plan];
    const paths = [...new Set(candidate.filter((path) => known.some((p) => touches(path, p))))];
    const incomplete = other.pr !== null && (!other.filesComplete || other.files === null);
    return paths.length || incomplete ? [{ ticket: other.ticket, pr: other.pr, paths, incomplete }] : [];
  });
}

/** The same lines go to the CLI and coordinator's plan item. */
export function overlapLines(reading: Pick<OverlapReading, "overlaps" | "incomplete">): string[] {
  const lines = reading.overlaps.flatMap((o) => {
    const who = `${o.ticket}${o.pr === null ? "" : ` (PR #${o.pr})`}`;
    return [
      ...(o.paths.length
        ? [`Overlaps ${who}: ${o.paths.join(", ")}${o.paths.some(isGlob) ? " (may overlap)" : ""}`]
        : []),
      ...(o.incomplete ? [`Comparison incomplete for ${who}: not all PR files are available.`] : []),
    ];
  });
  if (reading.incomplete) lines.push("Comparison incomplete: the stored fleet or GitHub reading is unavailable.");
  return lines;
}
