/** Coordinator-only staging check: ONE launch, no automatic allocation retry. */
import type { AgentEvent } from "../packages/core/src/provider.ts";

if (process.env.ARMADA_RUNTIME_SMOKE !== "one_real_boat_launch")
  throw Error("Set ARMADA_RUNTIME_SMOKE=one_real_boat_launch explicitly.");
const origin = new URL(process.env.ARMADA_URL ?? "");
if (origin.protocol !== "https:" || origin.href !== `${origin.origin}/`)
  throw Error("ARMADA_URL must be an HTTPS origin.");
const token = process.env.ARMADA_TOKEN;
const golden = process.env.ARMADA_RUNTIME_GOLDEN;
const org = process.env.ARMADA_RUNTIME_ORG;
const credentialId = process.env.ARMADA_RUNTIME_CREDENTIAL_ID;
if (!token || !golden || !org || !credentialId) throw Error("Missing coordinator staging inputs.");
interface Reply {
  boatRuntime?: { enabled?: boolean; diagnosticsVersion?: number };
  sandbox?: { id?: string; goldenId?: string; boatRuntime?: boolean };
  runtime?: { kind?: string; epoch?: string };
  promptId?: string;
  source?: string;
  runtimeFailure?: { status: string; reason: string };
  cursor?: string | null;
  events?: AgentEvent[];
  sandboxes?: { id: string; status: string; stoppedAt?: string | null }[];
}
async function api(path: string, body: object): Promise<Reply> {
  const response = await fetch(new URL(`/api/v1/${path}`, origin), {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000),
  });
  if (!response.ok) throw Error(`Staging operation ${path} refused (${response.status}); no launch retry.`);
  return (await response.json()) as Reply;
}
const options = await api("launch/options", {});
if (options.boatRuntime?.enabled !== true || options.boatRuntime.diagnosticsVersion !== 1)
  throw Error(
    "Use the armada-server origin with experimental Boat runtime diagnostics v1 enabled; no launch attempted.",
  );
const marker = `ARMADA_RUNTIME_${crypto.randomUUID().replaceAll("-", "")}`;
let id: string | undefined;
let goldenId: string | undefined;
let failure: unknown;
try {
  const launched = await api("sandbox/launch-runtime-v1", {
    runtimeVersion: 1,
    boatRuntime: true,
    provider: "boat",
    harness: "codex",
    golden,
    org,
    credentialId,
    ...(process.env.ARMADA_RUNTIME_MODEL ? { model: process.env.ARMADA_RUNTIME_MODEL } : {}),
    prompt: `Reply exactly ${marker}. Do not use tools or change files.`,
    connections: [],
    skipSkillDefaults: true,
    ttlSeconds: 900,
  });
  id = launched.sandbox?.id;
  goldenId = launched.sandbox?.goldenId;
  if (
    !id ||
    launched.sandbox?.boatRuntime !== true ||
    launched.runtime?.kind !== "armada" ||
    !/^[1-9][0-9]{0,18}$/.test(launched.runtime?.epoch ?? "") ||
    !launched.promptId
  )
    throw Error("Missing runtime launch acknowledgement.");
  const deadline = Date.now() + 300000;
  let cursor: string | undefined;
  let answer = false,
    finished = false;
  while (Date.now() < deadline && (!answer || !finished)) {
    const page = await api("logs/read", { id, all: true, ...(cursor ? { cursor } : {}) });
    if (page.runtimeFailure?.status === "failed")
      throw Error(
        "Armada runtime failed; inspect logs/read.runtimeFailure.reason and sandbox statusReason. No launch retry.",
      );
    if (page.source !== "armada-runtime") throw Error("History did not come from the Armada journal archive.");
    for (const event of page.events ?? []) {
      if (event.promptId !== launched.promptId) continue;
      if (
        event.kind === "message" &&
        event.responseKind !== "tool_result" &&
        event.partial === false &&
        event.text.trim() === marker
      )
        answer = true;
      if (event.kind === "prompt" && event.status === "finished") finished = true;
      if (event.kind === "prompt" && ["failed", "interrupted"].includes(event.status))
        throw Error("Runtime prompt did not finish successfully.");
    }
    cursor = page.cursor ?? cursor;
    if (!answer || !finished) await Bun.sleep(1000);
  }
  if (!answer || !finished) throw Error("Timed out waiting for archived runtime answer/terminal event.");
  console.log(
    JSON.stringify({
      sandboxId: id,
      source: "armada-runtime",
      epoch: launched.runtime.epoch,
      promptId: launched.promptId,
      answer: "verified",
    }),
  );
} catch (error) {
  failure = error;
}
try {
  if (id) {
    await api("sandbox/stop", { id });
    const deadline = Date.now() + 180000;
    let stopped = false;
    while (Date.now() < deadline) {
      const page = await api("sandbox/list", { owner: "me", ...(goldenId ? { golden: goldenId } : {}), limit: 200 });
      if (
        page.sandboxes?.some(
          (row) =>
            row.id === id &&
            (row.status === "stopped" ||
              (row.status === "failed" &&
                typeof row.stoppedAt === "string" &&
                Number.isFinite(Date.parse(row.stoppedAt)))),
        )
      ) {
        stopped = true;
        break;
      }
      await Bun.sleep(1000);
    }
    if (!stopped) throw Error(`Stop not confirmed for ${id}; coordinator must inspect it. Do not launch again.`);
    console.log("Experimental runtime compute stopped; resume/work preservation unsupported.");
  }
} catch (error) {
  failure ??= error;
}
if (failure) throw failure;
