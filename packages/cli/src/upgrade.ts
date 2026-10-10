// Upgrade through npm, verify the executable on PATH, then let that executable
// judge setup against its own bundled pointers and vendored skills.
import {
  ARMADA_PACKAGE,
  type Check,
  checkPublished,
  compareVersions,
  type InfoCheck,
  NPM_CHECK_MS,
  NPM_REGISTRY_URL,
  versionToInstall,
} from "@armada/core";
import { heard } from "./api.ts";
import type { Io } from "./io.ts";
import { CommandError, requireExec } from "./repo.ts";

const ATTEMPTS = 5;
const WAIT_MS = 30_000;

async function targetVersion(io: Io): Promise<string> {
  const fetch = io.fetch ?? globalThis.fetch;
  const server = heard(io).server;
  let target: string | null = null;
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      cache: "no-store",
      signal: AbortSignal.timeout(NPM_CHECK_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { "dist-tags"?: { latest?: unknown } } | null;
      const latest = body?.["dist-tags"]?.latest;
      if (typeof latest === "string" && /^\d+\.\d+\.\d+$/.test(latest)) target = latest;
    }
  } catch {
    // The server's latest is already publication-checked; recheck below.
  }
  if (server) {
    if (server.latest && (!target || compareVersions(server.latest, target) > 0)) target = server.latest;
    target = versionToInstall(server.minimum, target);
  }
  if (!target || !/^\d+\.\d+\.\d+$/.test(target))
    throw new CommandError(
      "cannot determine the newest Armada version from npm; retry armada upgrade once npm answers",
    );
  return target;
}

export async function upgrade(io: Io, running: string, root: string): Promise<number> {
  if (io.env.ARMADA_TICKET?.trim())
    throw new CommandError("workers keep the Armada version their launch pinned; the coordinator runs armada upgrade");
  const exec = requireExec(io);
  const target = await targetVersion(io);
  if (running !== "0.0.0" && compareVersions(target, running) < 0)
    throw new CommandError(`npm serves Armada ${target}, older than this CLI ${running}; retry after publication`);
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    const published = await checkPublished(target, io.fetch ?? globalThis.fetch);
    if (published.state === "published") break;
    if (attempt === ATTEMPTS)
      throw new CommandError(
        `npm does not serve Armada ${target} after ${ATTEMPTS} checks; retry armada upgrade later`,
      );
    io.stderr(`armada: waiting for npm to serve Armada ${target} (${attempt}/${ATTEMPTS}); next check in 30 s\n`);
    await sleep(WAIT_MS);
  }
  const install = await exec("npm", ["install", "-g", `${ARMADA_PACKAGE}@${target}`], {
    cwd: root,
    timeoutMs: 120_000,
  });
  if (install.code !== 0 || install.timedOut)
    throw new CommandError(`installing Armada ${target} failed; setup was not refreshed`);
  const version = await exec("armada", ["--version"], { cwd: root, timeoutMs: 10_000 });
  if (version.code !== 0 || version.timedOut || version.stdout.trim() !== target)
    throw new CommandError(
      `armada --version did not verify Armada ${target}; check npm's global bin on PATH before retrying`,
    );

  const doctor = await exec("armada", ["doctor", "--json"], { cwd: root, timeoutMs: 60_000 });
  let report: { schemaVersion?: number; armadaVersion?: string; root?: string; checks?: (Check | InfoCheck)[] } | null =
    null;
  try {
    report = JSON.parse(doctor.stdout);
  } catch {}
  if (
    doctor.timedOut ||
    (doctor.code !== 0 && doctor.code !== 1) ||
    report?.schemaVersion !== 1 ||
    report.armadaVersion !== target ||
    report.root !== root ||
    !Array.isArray(report.checks) ||
    !report.checks.length ||
    report.checks.some(
      (check) => !check || typeof check.id !== "string" || !["ok", "info", "warning", "error"].includes(check.level),
    )
  )
    throw new CommandError("the upgraded doctor could not check setup; run armada doctor before refreshing it");
  const manualGaps = report.checks.some(
    (check) => check.repair === "manual" && ["warning", "error"].includes(check.level),
  );
  const setupBehind = report.checks.some(
    (check) => check.repair === "init" && ["warning", "error"].includes(check.level),
  );
  if (
    report.checks.some(
      (check) => check.id === "skills-version" && check.level !== "ok" && check.fix?.includes("update the CLI"),
    )
  )
    throw new CommandError(
      `this project's skills require a CLI newer than Armada ${target}; retry after npm serves it`,
    );
  if (setupBehind) {
    io.stdout(`Armada ${target} verified; repairing setup gaps with armada init --merge.\n`);
    if (manualGaps)
      io.stderr("armada: doctor also found setup gaps needing manual repair; run armada doctor for the fixes.\n");
    const signing = report.checks.find((check) => check.id === "git-signing" && check.level === "warning");
    if (signing)
      io.stderr(
        `armada: setup commit signing: ${signing.message.replace(/\s+/g, " ")}; fix: ${signing.fix?.replace(/\s+/g, " ") ?? "run armada doctor"}; if branch rules allow unsigned commits, retry with GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false armada init --merge.\n`,
      );
    const init = await exec("armada", ["init", "--merge"], { cwd: root, timeoutMs: 20 * 60_000 });
    if (init.code !== 0 || init.timedOut)
      throw new CommandError(
        `Armada ${target} is installed, but setup refresh did not finish; run armada init --merge to resume`,
      );
    io.stdout(
      `Armada ${target} installed; setup refresh completed on the default branch; update this checkout from it and run armada doctor.\n`,
    );
  } else if (manualGaps)
    io.stdout(`Armada ${target} installed; setup needs manual repair; run armada doctor for the fixes.\n`);
  else io.stdout(`Armada ${target} installed; setup is up to date.\n`);
  return 0;
}
