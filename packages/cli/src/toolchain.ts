import type { Check, RepoView } from "@armada/core";
import type { Exec, Io } from "./io.ts";

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/;

function versionParts(text: string) {
  const parts = VERSION.exec(text);
  // Numeric prerelease identifiers follow the same no-leading-zero rule.
  if (parts?.[4]?.split(".").some((id) => /^0\d+$/.test(id))) return null;
  return parts;
}

/** Advisory only: compare the installed manager with the checkout's exact pin. */
export async function packageManagerChecks(
  view: Pick<RepoView, "readFile">,
  exec: Exec | undefined,
  root: string,
  env: Io["env"],
): Promise<Check[]> {
  if (!exec) return [];
  let pin: unknown;
  try {
    const text = await view.readFile("package.json");
    pin = text ? JSON.parse(text)?.packageManager : null;
  } catch {
    return [];
  }
  if (typeof pin !== "string") return [];
  // Corepack pins may carry a hash after '+'. Never run a name from the file.
  const match = /^(bun|pnpm|npm|yarn)@(.+)$/.exec(pin);
  if (!match?.[1] || !match[2]) return [];
  const manager = match[1];
  const parts = versionParts(match[2]);
  if (!parts) return [];
  if (parts[5]) {
    const hash = /^sha(224|256|384|512)\.([a-fA-F\d]+)$/.exec(parts[5]);
    if (!hash?.[1] || !hash[2] || hash[2].length !== Number(hash[1]) / 4) return [];
  }
  const pinned = match[2].split("+")[0] ?? match[2];
  const result = await exec(manager, ["--version"], {
    cwd: root,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    // Observe the manager local checks use, without hydrating a Corepack cache.
    env: { ...env, COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  }).catch(() => null);
  if (result?.code !== 0 || result.timedOut || result.outputExceeded) return [];
  const local = result.stdout.trim();
  const version = versionParts(local);
  if (!version) return [];
  if (version[1] === parts[1] && version[2] === parts[2]) return [];
  let fix = `npm install -g ${manager}@${pinned}`;
  if (manager === "bun") fix = `curl -fsSL https://bun.sh/install | bash -s "bun-v${pinned}"`;
  else if (manager === "yarn") fix = `corepack enable && corepack install --global yarn@${pinned}`;
  return [
    {
      id: "package-manager",
      level: "warning",
      message: `package.json pins ${manager}@${pinned}; local ${manager} is ${local} (major/minor differs)`,
      fix,
    },
  ];
}
