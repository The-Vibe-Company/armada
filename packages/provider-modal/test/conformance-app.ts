/** Opt-in tool boundary only. Never imported by the provider or Armada client. */
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

export interface AppRow {
  id: string;
  name: string;
  state: string;
  tasks: number;
}
export interface AppAdapter {
  list(environment: string): Promise<AppRow[]>;
  create(name: string, environment: string): Promise<string>;
  stop(id: string, environment: string): Promise<void>;
}
export interface AppReceipt {
  version: 1;
  runId: string;
  name: string;
  environment: string;
  appId?: string;
  creation: "pending" | "confirmed";
  finalization: "incomplete" | "stopped";
}
export interface CleanupProof {
  complete: boolean;
  resources: { sandboxId: string; phase: string; registryConfirmed: boolean }[];
  imageCount: number;
}

/** Caller must retain this journal, including pending/ambiguous creations. Never retry creation. */
export async function createOwnedApp(
  adapter: AppAdapter,
  environment: string,
  save: (receipt: AppReceipt) => Promise<void>,
): Promise<AppReceipt> {
  if (!environment || !environment.trim()) throw Error("fixture_environment_required");
  const runId = crypto.randomUUID();
  const receipt: AppReceipt = {
    version: 1,
    runId,
    name: `armada-conformance-${runId}`,
    environment,
    creation: "pending",
    finalization: "incomplete",
  };
  await save(receipt);
  const before = await adapter.list(environment);
  if (before.some((x) => x.name === receipt.name)) throw Error("fixture_name_collision");
  const id = await adapter.create(receipt.name, environment);
  if (before.some((x) => x.id === id)) throw Error("fixture_not_new");
  receipt.appId = id;
  await save(receipt);
  const after = (await adapter.list(environment)).filter((x) => x.id === id && x.name === receipt.name);
  if (after.length !== 1 || after[0]?.state !== "deployed" || after[0]?.tasks !== 0)
    throw Error("fixture_creation_uncertain");
  receipt.creation = "confirmed";
  await save(receipt);
  return receipt;
}

/** No name/prefix/age based adoption. Readback, never a successful stop exit, is terminal proof. */
export async function finalizeOwnedApp(
  adapter: AppAdapter,
  receipt: AppReceipt,
  proof: CleanupProof,
  save: (receipt: AppReceipt) => Promise<void>,
): Promise<void> {
  if (
    receipt.version !== 1 ||
    receipt.creation !== "confirmed" ||
    !receipt.appId ||
    receipt.name !== `armada-conformance-${receipt.runId}` ||
    !receipt.environment ||
    !proof.complete ||
    proof.imageCount !== 0 ||
    proof.resources.some((x) => x.phase !== "deleted" || !x.registryConfirmed)
  )
    throw Error("fixture_cleanup_incomplete");
  receipt.finalization = "incomplete";
  await save(receipt);
  const read = async () => {
    const rows = (await adapter.list(receipt.environment)).filter((x) => x.id === receipt.appId);
    if (rows.length !== 1 || rows[0]?.name !== receipt.name || rows[0]?.tasks !== 0)
      throw Error("fixture_state_uncertain");
    return rows[0];
  };
  const current = await read();
  if (current.state !== "stopped") {
    if (current.state !== "deployed") throw Error("fixture_state_uncertain");
    await adapter.stop(receipt.appId, receipt.environment);
    if ((await read()).state !== "stopped") throw Error("fixture_stop_unconfirmed");
  }
  await save({ ...receipt, finalization: "stopped" });
  receipt.finalization = "stopped";
}

/** Public Modal CLI 1.6.3. Inject execution in tests; never forward diagnostics or inherited env. */
export function cliAppAdapter(
  tokenId: string,
  tokenSecret: string,
  create: AppAdapter["create"],
  execute = async (args: string[], env: Record<string, string>) => {
    const child = Bun.spawn(["modal", ...args], { env, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw Error("modal_cli_failed");
    return output;
  },
): AppAdapter {
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    MODAL_TOKEN_ID: tokenId,
    MODAL_TOKEN_SECRET: tokenSecret,
    MODAL_CONFIG_PATH: "/dev/null",
  };
  return {
    create,
    async list(environment) {
      const rows: unknown = JSON.parse(await execute(["app", "list", "--env", environment, "--json"], env));
      if (!Array.isArray(rows)) throw Error("modal_cli_invalid_inventory");
      return rows.map((row) => {
        const tasks = Number(row.tasks);
        if (
          typeof row.app_id !== "string" ||
          typeof row.description !== "string" ||
          typeof row.state !== "string" ||
          !/^\d+$/.test(String(row.tasks)) ||
          !Number.isSafeInteger(tasks)
        )
          throw Error("modal_cli_invalid_inventory");
        return { id: row.app_id, name: row.description, state: row.state.toLowerCase(), tasks };
      });
    },
    async stop(id, environment) {
      await execute(["app", "stop", id, "--env", environment, "--yes"], env);
    },
  };
}

export async function appJournal(directory: string) {
  // Exclusive directory: never overwrite a previous run's evidence.
  await mkdir(directory, { mode: 0o700 });
  let sequence = 0;
  return async (receipt: unknown) => {
    const file = await open(join(directory, `${sequence++}.json`), "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(receipt));
      await file.sync();
    } finally {
      await file.close();
    }
    const dir = await open(directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  };
}
