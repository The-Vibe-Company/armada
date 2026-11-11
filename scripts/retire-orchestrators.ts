/**
 * PRE-DEPLOY owner cleanup against the retained Armada 2.21 API.
 * Dry-run is the default. Never run after the server tombstones are deployed.
 * No credentials are stored in the plan. Never auto-retry an unknown mutation.
 */
import { open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

type Parent = { id: string; ownerId: string; orgId: string; revision: number; state: string };
type Detail = { orchestrator: Parent; childSandboxIds: string[]; operations: { id: string; state: string }[] };
type Stop = {
  id: string;
  kind: "parent" | "child";
  revision?: number;
  key: string;
  state: "planned" | "dispatched" | "complete";
  operationId?: string;
};
export type RetirementPlan = {
  version: 1;
  origin: string;
  owner: string;
  org: string;
  createdAt: string;
  parents: Detail[];
  children: { id: string; status: string }[];
  stops: Stop[];
};
export type CleanupApi = (method: "GET" | "POST", path: string, body?: object, key?: string) => Promise<unknown>;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Unexpected API response.");
  return value as Record<string, unknown>;
};

/** Every page and every linked child is checked under the caller's actual owner token. */
export async function inventory(api: CleanupApi, origin: string, owner: string, org: string): Promise<RetirementPlan> {
  const caller = object(await api("POST", "/account/status"));
  if (caller.userId !== owner) throw Error("The token does not belong to the selected owner.");
  const parents: Detail[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ orgId: org, limit: "100", ...(cursor ? { cursor } : {}) });
    const page = object(await api("GET", `/orchestrators?${query}`));
    if (!Array.isArray(page.items)) throw Error("Owner inventory is unavailable; do not deploy tombstones.");
    for (const item of page.items) {
      const id = object(item).id;
      if (typeof id !== "string" || seen.has(id)) throw Error("Invalid or repeated parent inventory.");
      seen.add(id);
      const detail = (await api(
        "GET",
        `/orchestrators/${encodeURIComponent(id)}?orgId=${encodeURIComponent(org)}`,
      )) as Detail;
      if (
        detail.orchestrator?.id !== id ||
        detail.orchestrator.ownerId !== owner ||
        detail.orchestrator.orgId !== org ||
        !Number.isSafeInteger(detail.orchestrator.revision) ||
        !Array.isArray(detail.childSandboxIds) ||
        !Array.isArray(detail.operations)
      )
        throw Error("Owner inventory identity or revision mismatch.");
      parents.push({
        orchestrator: {
          id,
          ownerId: owner,
          orgId: org,
          revision: detail.orchestrator.revision,
          state: detail.orchestrator.state,
        },
        childSandboxIds: [...detail.childSandboxIds],
        operations: detail.operations.map(({ id, state }) => ({ id, state })),
      });
    }
    const next = page.cursor;
    if (next !== null && next !== undefined && typeof next !== "string") throw Error("Invalid inventory cursor.");
    if (next && next === cursor) throw Error("Inventory cursor did not advance.");
    cursor = next ? String(next) : undefined;
  } while (cursor);
  const children: RetirementPlan["children"] = [];
  for (const id of new Set(parents.flatMap((parent) => parent.childSandboxIds))) {
    const child = object(await api("POST", "/sandbox/detail", { id, org }));
    if (child.id !== id || typeof child.status !== "string") throw Error("Child status could not be checked.");
    children.push({ id, status: child.status });
  }
  return {
    version: 1,
    origin,
    owner,
    org,
    createdAt: new Date().toISOString(),
    parents,
    children,
    stops: [
      ...children
        .filter((child) => child.status !== "stopped")
        .map((child) => ({
          id: child.id,
          kind: "child" as const,
          key: crypto.randomUUID(),
          state: "planned" as const,
        })),
      ...parents
        .filter((parent) => parent.orchestrator.state !== "stopped")
        .map((parent) => ({
          id: parent.orchestrator.id,
          kind: "parent" as const,
          revision: parent.orchestrator.revision,
          key: crypto.randomUUID(),
          state: "planned" as const,
        })),
    ],
  };
}

/** save() MUST publish durable nonsecret state before each dispatch. Failed/unknown receipts
 * retain their exact key/revision. Resume never invents a key or recreates an identity. */
export async function applyPlan(api: CleanupApi, plan: RetirementPlan, save: () => Promise<void>) {
  // Inventory must remain complete even when cleanup is blocked. Admission, not
  // discovery, refuses unsettled work before any stop state is saved/dispatched.
  if (
    plan.parents.some((parent) =>
      parent.operations.some((operation) => operation.state === "pending" || operation.state === "uncertain"),
    )
  )
    throw Error(
      "An owner operation is pending/uncertain. Preserve the plan and recover its exact receipt with pinned Armada 2.21 before applying cleanup.",
    );
  if (object(await api("POST", "/account/status")).userId !== plan.owner)
    throw Error("The token does not belong to the plan owner.");
  for (const stop of plan.stops) {
    const parent = plan.parents.find((item) => item.orchestrator.id === stop.id)?.orchestrator;
    if (
      !stop.key ||
      !["planned", "dispatched", "complete"].includes(stop.state) ||
      (stop.kind === "parent"
        ? !parent || parent.revision !== stop.revision
        : stop.kind !== "child" || !plan.children.some((child) => child.id === stop.id))
    )
      throw Error("Stop does not match the reviewed inventory and stable revision/key.");
  }
  for (const stop of plan.stops) {
    if (stop.state === "complete") continue;
    if (stop.state === "dispatched" && !stop.operationId)
      throw Error(
        "Outcome unknown. Use the saved exact key/revision with pinned Armada 2.21 recovery; do not redispatch.",
      );
    if (stop.state === "planned") {
      stop.state = "dispatched";
      await save();
      const result = object(
        await api(
          "POST",
          stop.kind === "parent" ? `/orchestrators/${encodeURIComponent(stop.id)}/stop` : "/sandbox/stop",
          stop.kind === "parent"
            ? { orgId: plan.org, expectedRevision: stop.revision }
            : { id: stop.id, org: plan.org },
          stop.key,
        ),
      );
      if (stop.kind === "parent") {
        if (typeof result.id !== "string")
          throw Error("Missing stop receipt. Preserve the plan and recover with Armada 2.21.");
        stop.operationId = result.id;
        await save();
      }
    }
    if (stop.kind === "parent") {
      let complete = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const detail = (await api(
          "GET",
          `/orchestrators/${encodeURIComponent(stop.id)}?orgId=${encodeURIComponent(plan.org)}`,
        )) as Detail;
        const receipt = detail.operations?.find((operation) => operation.id === stop.operationId);
        if (receipt?.state === "succeeded" && detail.orchestrator?.state === "stopped") {
          complete = true;
          break;
        }
        if (!receipt || receipt.state !== "pending") break;
      }
      if (!complete)
        throw Error(
          "Stop is pending, uncertain or failed. Preserve the plan; poll/recover its exact receipt with pinned Armada 2.21.",
        );
    } else {
      const detail = object(await api("POST", "/sandbox/detail", { id: stop.id, org: plan.org }));
      if (detail.status !== "stopped")
        throw Error("Child stop is unconfirmed; retain the plan and recover without redispatch.");
    }
    stop.state = "complete";
    await save();
  }
  const final = await inventory(api, plan.origin, plan.owner, plan.org);
  if (
    final.parents.some((parent) => parent.orchestrator.state !== "stopped") ||
    final.children.some((child) => child.status !== "stopped") ||
    final.parents.some((parent) => !plan.parents.some((prior) => prior.orchestrator.id === parent.orchestrator.id)) ||
    final.children.some((child) => !plan.children.some((prior) => prior.id === child.id))
  )
    throw Error(
      "Inventory changed or resources remain active; cleanup is incomplete. Review a new dry-run without overwriting this plan.",
    );
  // Repeat every authorized status read; never claim compute closure for an unchecked child.
  for (const child of plan.children)
    if (object(await api("POST", "/sandbox/detail", { id: child.id, org: plan.org })).status !== "stopped")
      throw Error("A child is not confirmed stopped; cleanup is incomplete.");
}

/** Sync file bytes and directory publication before treating a plan as durable. */
async function publish(path: string, plan: RetirementPlan, initial = false) {
  const target = initial ? path : path + ".next";
  const file = await open(target, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(plan, null, 2));
    await file.sync();
  } finally {
    await file.close();
  }
  if (!initial) await rename(target, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
  const originInput = value("--origin"),
    owner = value("--owner"),
    org = value("--org"),
    path = value("--plan");
  if (!originInput || !owner || !org || !path)
    throw Error(
      "Use --origin HTTPS_ORIGIN --owner USER_ID --org ORG_ID --plan FILE [--apply --confirm-owner USER_ID].",
    );
  const url = new URL(originInput);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw Error("Use an HTTPS origin without credentials, path or query.");
  const origin = url.origin;
  const token = args.includes("--token-stdin") ? (await Bun.stdin.text()).trim() : process.env.ARMADA_TOKEN?.trim();
  if (!token) throw Error("Supply the owner's ARMADA_TOKEN environment or --token-stdin; never pass a token argument.");
  const api: CleanupApi = async (method, route, body, key) => {
    const response = await fetch(origin + "/api/v1" + route, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw Error(
        `Cleanup API refused HTTP ${response.status}. Preserve the plan; do not deploy or recreate operations.`,
      );
    return response.json();
  };
  if (!args.includes("--apply")) {
    const plan = await inventory(api, origin, owner, org);
    // Refuse to overwrite prior keys or proof; apply only a separately reviewed plan.
    await publish(path, plan, true);
    console.log("Dry-run plan saved. No stop dispatched. Review all parents and children before --apply.");
    return;
  }
  if (value("--confirm-owner") !== owner) throw Error("--apply requires --confirm-owner matching --owner.");
  const plan = JSON.parse(await readFile(path, "utf8")) as RetirementPlan;
  if (plan.version !== 1 || plan.origin !== origin || plan.owner !== owner || plan.org !== org)
    throw Error("Plan scope does not match explicit origin/owner/org.");
  const save = () => publish(path, plan);
  await applyPlan(api, plan, save);
  console.log(
    "All planned parent/child API stop states confirmed. Independently confirm provider physical exits. Retained disks/history are not deleted. Repeat inventory for every owner.",
  );
}
if (import.meta.main)
  main().catch(() => {
    console.error(
      "Retirement incomplete. Preserve the plan and exact operation keys; use pinned Armada 2.21 recovery before deploying tombstones.",
    );
    process.exitCode = 1;
  });
