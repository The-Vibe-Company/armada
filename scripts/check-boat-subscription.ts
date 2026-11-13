/** Coordinator-only: one canonical Boat lifecycle, with strict subscription/cost acceptance. */
import { fileURLToPath } from "node:url";

class Refused extends Error {}
const recoveryIds = new Set<string>();
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const positiveCount = (v: unknown): v is number => count(v) && v > 0;
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const epoch = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
function dollars(v: unknown): bigint {
  if (typeof v !== "string" || !/^(0|[1-9]\d{0,31})(\.\d{1,18})?$/.test(v)) throw new Refused("Invalid cost receipt.");
  const [whole, fraction = ""] = v.split(".");
  return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
}
async function collect(stream: ReadableStream<Uint8Array>, retain: boolean) {
  const decoder = new TextDecoder();
  let bytes = 0,
    text = "",
    overflow = false;
  for await (const chunk of stream) {
    if (!retain) continue;
    bytes += chunk.byteLength;
    if (bytes > 262144) {
      overflow = true;
      continue;
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return { text: text + decoder.decode(), overflow };
}
function proof(receipt: Record<string, unknown>) {
  const usage = receipt.usageProof;
  if (
    !record(usage) ||
    !positiveCount(usage.turnCount) ||
    usage.admission !== "frozen" ||
    !record(usage.tokenTotals) ||
    !count(usage.tokenTotals.inputTokens) ||
    !count(usage.tokenTotals.outputTokens) ||
    usage.tokenTotals.inputTokens + usage.tokenTotals.outputTokens === 0 ||
    !record(usage.cost) ||
    usage.cost.status !== "priced" ||
    usage.cost.basis !== "api_equivalent" ||
    usage.cost.unknown !== null ||
    dollars(usage.cost.usd) <= 0n
  )
    throw new Refused("Positive subscription-priced usage is required; unknown/zero/API-key cost is not acceptance.");
  return { turnCount: usage.turnCount, usd: usage.cost.usd, amount: dollars(usage.cost.usd) };
}
async function main() {
  if (process.env.ARMADA_RUNTIME_SMOKE !== "one_real_boat_launch")
    throw new Refused("Explicit one-launch acknowledgement required.");
  const harness = process.env.ARMADA_RUNTIME_HARNESS ?? "codex";
  if (harness !== "codex" && harness !== "claude")
    throw new Refused("This check requires Codex ChatGPT or Claude token authentication; no launch attempted.");
  const kind = harness === "codex" ? "codex_auth" : "claude_oauth";
  const origin = new URL(process.env.ARMADA_URL ?? "");
  const token = process.env.ARMADA_TOKEN,
    org = process.env.ARMADA_RUNTIME_ORG,
    credentialId = process.env.ARMADA_RUNTIME_CREDENTIAL_ID;
  if (
    origin.protocol !== "https:" ||
    origin.href !== `${origin.origin}/` ||
    !token ||
    !org ||
    !uuid(credentialId) ||
    !process.env.ARMADA_RUNTIME_GOLDEN
  )
    throw new Refused("Missing or invalid existing staging inputs; no launch attempted.");
  const response = await fetch(new URL("/api/v1/creds/list", origin), {
    method: "POST",
    redirect: "error",
    credentials: "omit",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ org }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Refused("Account inventory refused; no launch attempted.");
  const inventory: unknown = await response.json();
  if (!record(inventory) || !Array.isArray(inventory.user) || !Array.isArray(inventory.orgs))
    throw new Refused("Account inventory unavailable; no launch attempted.");
  const accounts: unknown[] = [...inventory.user];
  for (const item of inventory.orgs) {
    if (!record(item) || !Array.isArray(item.credentials))
      throw new Refused("Invalid org inventory; no launch attempted.");
    accounts.push(...item.credentials);
  }
  const matches = accounts.filter(
    (a) => record(a) && typeof a.id === "string" && a.id.toLowerCase() === credentialId.toLowerCase(),
  );
  const account = matches[0];
  if (
    matches.length !== 1 ||
    !record(account) ||
    account.kind !== kind ||
    account.status !== "active" ||
    !positiveCount(account.version) ||
    (account.expiresAt != null &&
      (typeof account.expiresAt !== "string" || !(Date.parse(account.expiresAt) > Date.now())))
  )
    throw new Refused(`Select one active ${kind} account; API keys do not prove subscriptions. No launch attempted.`);
  // One existing allocator/cleanup owner. No retry, second launch, or new product selection.
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(new URL("./check-boat-runtime.ts", import.meta.url)), "--usage", "--resume"],
    {
      env: { ...process.env, ARMADA_RUNTIME_HARNESS: harness },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, output, errors] = await Promise.all([
    child.exited,
    collect(child.stdout, true),
    collect(child.stderr, true),
  ]);
  const receipts: Record<string, unknown>[] = [];
  let malformed = false;
  for (const line of output.text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed = true;
      continue;
    }
    if (record(parsed)) {
      receipts.push(parsed);
      if (uuid(parsed.sandboxId)) recoveryIds.add(parsed.sandboxId);
    }
  }
  // Preserve only the canonical cleanup error's UUID, never its raw stderr.
  for (const match of errors.text.matchAll(/Stop not confirmed for ([a-f0-9-]{36});/gi))
    if (uuid(match[1])) recoveryIds.add(match[1]);
  if (code !== 0 || output.overflow || errors.overflow || malformed)
    throw new Refused(
      "Canonical lifecycle failed. Inspect retained allocations before retrying; no launch retry here.",
    );
  const initial = receipts.filter((r) => r.answer === "verified"),
    resumed = receipts.filter((r) => r.resume === "verified");
  if (initial.length !== 1 || resumed.length !== 1) throw new Refused("Missing initial/resumed lifecycle receipt.");
  const first = initial[0]!,
    last = resumed[0]!;
  if (
    !uuid(first.sandboxId) ||
    last.sandboxId !== first.sandboxId ||
    first.source !== "armada-runtime" ||
    last.source !== "armada-runtime" ||
    first.usage !== "verified" ||
    last.usageAfterResume !== "verified" ||
    last.costAfterResume !== "priced" ||
    !epoch(first.epoch) ||
    !epoch(last.epoch) ||
    last.previousEpoch !== first.epoch ||
    BigInt(last.epoch) !== BigInt(first.epoch) + 1n
  )
    throw new Refused("Mismatched source, sandbox or resumed epoch.");
  const before = proof(first),
    after = proof(last);
  if (after.turnCount <= before.turnCount || after.amount <= before.amount)
    throw new Refused("The resumed turn must add its own positive cost; historical totals do not pass.");
  // Read stopped immutable turn quotes as well: a paid follow-up cannot hide a
  // zero/unknown first or resumed turn behind a positive session subtotal.
  const statusResponse = await fetch(new URL("/api/v1/sandbox/status", origin), {
    method: "POST",
    redirect: "error",
    credentials: "omit",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: first.sandboxId, org }),
    signal: AbortSignal.timeout(30000),
  });
  if (!statusResponse.ok) throw new Refused("Stopped subscription usage unavailable; no launch retry.");
  const status: unknown = await statusResponse.json();
  const usage = record(status) ? status.usage : undefined;
  if (
    !record(usage) ||
    usage.turnCount !== after.turnCount ||
    !Array.isArray(usage.turns) ||
    usage.turns.length !== after.turnCount ||
    !record(usage.cost) ||
    usage.cost.currency !== "USD" ||
    usage.cost.basis !== "api_equivalent" ||
    usage.cost.unknown !== null ||
    usage.cost.unpricedTurns !== 0 ||
    dollars(usage.cost.usd) !== after.amount
  )
    throw new Refused("Stopped session cost differs from the verified lifecycle.");
  const quotes = new Map<string, string>();
  let total = 0n;
  for (const turn of usage.turns) {
    if (
      !record(turn) ||
      typeof turn.promptId !== "string" ||
      !turn.promptId ||
      quotes.has(turn.promptId) ||
      !count(turn.inputTokens) ||
      !count(turn.outputTokens) ||
      turn.inputTokens + turn.outputTokens === 0 ||
      !record(turn.pricing) ||
      turn.pricing.basis !== "api_equivalent" ||
      turn.pricing.unknown !== null ||
      typeof turn.pricing.credentialId !== "string" ||
      turn.pricing.credentialId.toLowerCase() !== credentialId.toLowerCase() ||
      turn.pricing.credentialVersion !== account.version ||
      dollars(turn.pricing.usd) <= 0n
    )
      throw new Refused(
        "Each own turn must have positive subscription-account USD, including first and resumed turns.",
      );
    total += dollars(turn.pricing.usd);
    quotes.set(turn.promptId, turn.pricing.usd as string);
  }
  if (
    typeof first.promptId !== "string" ||
    typeof last.promptId !== "string" ||
    first.promptId === last.promptId ||
    !quotes.has(first.promptId) ||
    !quotes.has(last.promptId) ||
    total !== after.amount
  )
    throw new Refused("First/resumed turn quotes or exact session sum are missing.");
  // Only this allowlisted receipt is printed. Never forward child output/account metadata/tokens.
  console.log(
    JSON.stringify({
      sandboxId: first.sandboxId,
      source: "armada-runtime",
      harness,
      subscription: kind,
      basis: "api_equivalent",
      firstPhaseUsd: before.usd,
      firstTurnUsd: quotes.get(first.promptId),
      resumedTurnUsd: quotes.get(last.promptId),
      resumedSessionUsd: after.usd,
      turnCount: after.turnCount,
      epoch: last.epoch,
      usage: "verified",
      cost: "positive",
      subscriptionAnswer: "verified",
      resume: "verified",
      refresh: "not_claimed",
    }),
  );
}
await main().catch((error) => {
  console.error(
    error instanceof Refused
      ? error.message
      : "Subscription staging check failed; inspect existing allocations before retrying.",
  );
  if (recoveryIds.size) console.error(`Recovery sandbox IDs: ${[...recoveryIds].join(", ")}`);
  process.exitCode = 1;
});
