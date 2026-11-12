/** Ordinary sandbox access probe. The owner API only observes and safely cleans up; the native model exercises MCP. */
export interface ScopedProbeCase {
  org: string;
  provider: "boat" | "modal";
  harness: "claude" | "codex";
  goldenId: string;
  modelAccountId: string;
  model: string;
  reasoningEffort?: string;
}
export interface ScopedProbeIo {
  request<T>(path: string, body: object): Promise<T>;
  poll<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T>;
  step<T>(name: string, action: () => Promise<T>): Promise<T>;
  withCleanup<T>(action: () => Promise<T>): Promise<T>;
  stopSandbox(id: string): Promise<void>;
  isNotReady(error: unknown): boolean;
  out(line: string): void;
}
export class ScopedAccessSmokeFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function fail(code: string): never {
  throw new ScopedAccessSmokeFailure(code);
}
function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function unpack(value: unknown, depth = 0): { result: Row; error: boolean; denied: boolean } {
  if (depth > 5) return { result: {}, error: true, denied: false };
  value = decoded(value);
  const data = row(value);
  const error = data.isError === true;
  if (data.structuredContent !== undefined && data.structuredContent !== null) {
    const nested = unpack(data.structuredContent, depth + 1);
    return { ...nested, error: error || nested.error };
  }
  if (Array.isArray(data.content)) {
    const parts = data.content.map((part) => unpack(row(part).text, depth + 1));
    const found = parts.find((part) => Object.keys(part.result).length) ?? parts[0];
    return {
      result: found?.result ?? {},
      error: error || parts.some((part) => part.error),
      denied: parts.some((part) => part.denied),
    };
  }
  return {
    result: row(data.result),
    error,
    denied:
      value === "scoped_authority_denied" ||
      data.message === "scoped_authority_denied" ||
      row(data.error).code === "scoped_authority_denied",
  };
}
function assistantAnswers(events: unknown[], expected: string): boolean {
  const messages = new Map<string, { text: string; partial: boolean }>();
  for (const raw of events) {
    const e = row(raw);
    if (e.kind !== "message" || e.responseKind === "tool_result" || e.parentToolUseId || e.retracted) continue;
    if (typeof e.text !== "string" || typeof e.partial !== "boolean" || typeof e.id !== "string") continue;
    const id = typeof e.messageId === "string" ? e.messageId : e.id;
    messages.set(id, {
      text: e.textMode === "delta" ? (messages.get(id)?.text ?? "") + e.text : e.text,
      partial: e.partial,
    });
  }
  return [...messages.values()].some((message) => !message.partial && message.text === expected);
}
const referenceCommand = "cat /home/user/.agents/skills/armada-tools/SKILL.md";
function referenceRead(name: string, input: Row): boolean {
  if (name !== "commandExecution" && name !== "exec_command") return false;
  if (typeof input.command !== "string") return false;
  const command = input.command.trim();
  const wrapped = /^(?:\/bin\/)?(?:bash|sh) -l?c (['"])(.*)\1$/.exec(command);
  return (wrapped?.[2] ?? command) === referenceCommand;
}
type Call = { id: string; name: string; input: Row; result: Row; error: boolean; denied: boolean };

export function createScopedProbe(item: ScopedProbeCase, enabled: boolean, io: ScopedProbeIo) {
  const launchKey = `smoke-scoped-${crypto.randomUUID()}`;
  const messageKey = `smoke-scoped-${crypto.randomUUID()}`;
  const stopKey = `smoke-scoped-${crypto.randomUUID()}`;
  const answer = `SCOPED_CHILD_${crypto.randomUUID()}`;
  const noAccess = `NO_ACCESS_${crypto.randomUUID()}`;
  const childPrompt = `Reply with exactly ${answer} and nothing else. Do not use tools or modify files.`;
  let before: Set<string> | undefined;
  let parentId: string | undefined;
  let promptId: string | undefined;
  let sendUnknown = false;
  let launchUnknown = false;
  let evidenceUnknown = false;
  let selection: Row | undefined;
  const claims = new Set<string>();
  const operations = new Set<string>();
  const events = new Map<string, Row>();
  const api = <T>(path: string, body: object) => io.request<T>(path, { org: item.org, ...body });
  async function snapshot(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (let page = 1; page <= 20; page++) {
      const result = await api<{ sandboxes: Row[]; hasMore: boolean; nextPage: number | null }>("sandbox/list", {
        owner: "me",
        golden: item.goldenId,
        limit: 200,
        page,
      });
      if (!Array.isArray(result?.sandboxes) || typeof result.hasMore !== "boolean") fail("scoped_invalid_list");
      for (const entry of result.sandboxes) {
        if (!uuid(entry.id)) fail("scoped_invalid_list");
        ids.add(entry.id);
      }
      if (!result.hasMore) return ids;
      if (result.nextPage !== page + 1) fail("scoped_incomplete_snapshot");
    }
    return fail("scoped_incomplete_snapshot");
  }
  async function logs(id: string) {
    // Re-read from the start: providers can complete a tool in an existing event.
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = await api<{ events: Row[]; cursor: string | null; hasMore: boolean }>("logs/read", {
        id,
        coalesce: true,
        maxBytes: 1_048_576,
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(result?.events) || typeof result.hasMore !== "boolean") fail("scoped_invalid_logs");
      for (const event of result.events) {
        if (typeof event.id !== "string") fail("scoped_invalid_logs");
        events.set(event.id, event);
      }
      if (!result.hasMore) return;
      if (!result.cursor || cursors.has(result.cursor)) fail("scoped_incomplete_logs");
      cursor = result.cursor;
      cursors.add(cursor);
    }
    fail("scoped_incomplete_logs");
  }
  function calls(turnOnly: boolean): Call[] {
    const found = new Map<string, Call>();
    for (const event of events.values()) {
      if (
        event.kind !== "message" ||
        (turnOnly &&
          (event.promptId !== promptId ||
            event.retracted ||
            event.parentToolUseId ||
            event.responseKind === "tool_result")) ||
        !Array.isArray(event.tools)
      )
        continue;
      for (const raw of event.tools) {
        const tool = row(raw);
        if (typeof tool.name !== "string" || typeof tool.id !== "string") continue;
        const name = tool.name.replace(/^mcp__armada_orchestrator__/, "");
        const input =
          tool.input === undefined && found.has(tool.id) ? found.get(tool.id)!.input : row(decoded(tool.input));
        if (referenceRead(name, input)) continue;
        const result = row(tool.result);
        const output = unpack(result.output);
        const previous = found.get(tool.id);
        if (!previous || tool.result !== undefined)
          found.set(tool.id, {
            id: tool.id,
            name,
            input,
            ...output,
            error: result.isError === true || output.error,
          });
      }
    }
    return [...found.values()];
  }
  function selected(input: Row): boolean {
    const chosen = row(input.selection);
    return (
      !!selection &&
      Object.keys(chosen).length === Object.keys(selection).length &&
      Object.entries(selection).every(([key, value]) => JSON.stringify(chosen[key]) === JSON.stringify(value))
    );
  }
  function adopt() {
    for (const call of calls(false)) {
      if (call.name !== "launch" || call.input.idempotencyKey !== launchKey) continue;
      launchUnknown = true;
      const receipt =
        uuid(call.result.id) && ["succeeded", "pending", "uncertain", "failed"].includes(String(call.result.state));
      if (receipt && uuid(call.result.id)) {
        operations.add(call.result.id);
        if (uuid(call.result.sandboxId)) claims.add(call.result.sandboxId);
      }
      if (
        call.denied ||
        (receipt && uuid(call.result.sandboxId) && ["succeeded", "failed"].includes(String(call.result.state)))
      )
        launchUnknown = false;
    }
  }
  const successful = (call: Call) => !call.error && call.result.state === "succeeded" && uuid(call.result.id);
  return {
    async prepare(): Promise<void> {
      if (before) fail("scoped_already_prepared");
      if (item.harness !== "codex") fail("scoped_codex_only");
      before = await io.step("scoped_snapshot", snapshot);
    },
    async run(id: string, credentialVersion: number): Promise<void> {
      if (!before || parentId || !uuid(id) || !Number.isSafeInteger(credentialVersion) || credentialVersion < 1)
        fail("scoped_not_prepared");
      parentId = id;
      selection = {
        goldenId: item.goldenId,
        harness: "codex",
        credentialId: item.modelAccountId,
        credentialVersion,
        model: item.model,
        skills: [],
        ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
      };
      const goal = `Use only the configured native MCP server armada_orchestrator tools launch, message, read, stop for this task. Never use CLI, HTTP, config, credential or grant reads. If needed, the ONLY terminal command allowed is exactly ${referenceCommand} to read the nonsecret tool reference; do not use other exec commands. Never retry a mutation or generate new keys. Launch at most ONE idle child using exactly ${JSON.stringify({ idempotencyKey: launchKey, selection })} (no initial prompt or TTL). After a succeeded launch, message that child's returned sandboxId with exactly ${JSON.stringify({ idempotencyKey: messageKey, text: childPrompt })}. Poll read with {sandboxId} at most 20 times until its events contain the child's actual nonpartial assistant answer ${answer}, not a prompt/tool echo. Then stop that same child using idempotencyKey ${stopKey}. If any mutation is pending/uncertain or fails, do not retry; stop this task and report the failure. If the native tools are unavailable or launch returns scoped_authority_denied, reply with exactly ${noAccess}. Do not fabricate tool results.`;
      await io.step("scoped_native_turn", async () => {
        sendUnknown = true;
        evidenceUnknown = true;
        const sent = await io.poll(
          async () => {
            try {
              return await api<{ promptId: string }>("sandbox/send", { id, prompt: goal });
            } catch (error) {
              if (!io.isNotReady(error)) throw error;
              return null;
            }
          },
          (result) => result !== null,
        );
        if (!sent || typeof sent.promptId !== "string" || !sent.promptId) fail("scoped_send_unknown");
        promptId = sent.promptId;
        sendUnknown = false;
        await io.poll(
          () =>
            api<{ prompt: { promptId: string; state: string } | null }>("sandbox/wait", {
              id,
              prompt_id: promptId,
              timeout_seconds: 0,
            }),
          (result) => {
            if (!result.prompt || result.prompt.promptId !== promptId) fail("scoped_invalid_wait");
            if (["failed", "interrupted"].includes(result.prompt.state)) fail("scoped_turn_failed");
            if (!["running", "finished"].includes(result.prompt.state)) fail("scoped_invalid_wait");
            return result.prompt.state === "finished";
          },
        );
      });
      await io.step("scoped_tool_evidence", async () => {
        await logs(id);
        evidenceUnknown = false;
        adopt();
        const tools = calls(true);
        const launches = tools.filter((call) => call.name === "launch");
        const launch = launches[0];
        const correctLaunch =
          launch &&
          Object.keys(launch.input).length === 2 &&
          launch.input.idempotencyKey === launchKey &&
          selected(launch.input);
        if (!enabled) {
          await io.step("scoped_no_option_refused", async () => {
            if (
              tools.some(
                (call) =>
                  (call.result.state === "succeeded" && uuid(call.result.id)) ||
                  (call.name === "read" && !call.error && uuid(call.result.id)),
              )
            )
              fail("scoped_negative_effect");
            const noTools = tools.length === 0;
            const denied = tools.length === 1 && correctLaunch && launch.error && launch.denied;
            if (
              (!noTools && !denied) ||
              !assistantAnswers(
                [...events.values()].filter((e) => e.promptId === promptId),
                noAccess,
              )
            )
              fail("scoped_negative_unproven");
          });
          return;
        }
        const verified = await io.step("scoped_child_launch", async () => {
          if (
            launches.length !== 1 ||
            !correctLaunch ||
            !launch ||
            !successful(launch) ||
            !uuid(launch.result.sandboxId)
          )
            fail("scoped_launch_unproven");
          const childId = launch.result.sandboxId;
          if (before?.has(childId) || childId === id) fail("scoped_child_identity");
          return { launch, childId };
        });
        const { childId } = verified;
        const messages = tools.filter((call) => call.name === "message");
        const reads = tools.filter((call) => call.name === "read");
        const stops = tools.filter((call) => call.name === "stop");
        const message = await io.step("scoped_child_message", async () => {
          const call = messages[0];
          if (
            messages.length !== 1 ||
            !call ||
            call.input.idempotencyKey !== messageKey ||
            call.input.text !== childPrompt ||
            call.input.sandboxId !== childId ||
            call.result.sandboxId !== childId ||
            !successful(call)
          )
            fail("scoped_message_unproven");
          return call;
        });
        const boundRead = (call: Call) =>
          call.result.id === childId &&
          call.result.orgId === item.org &&
          call.result.provider === item.provider &&
          call.result.harness === "codex" &&
          call.result.goldenId === item.goldenId &&
          call.result.credentialId === item.modelAccountId &&
          call.result.credentialVersion === credentialVersion;
        const answered = (call: Call) =>
          !call.error &&
          boundRead(call) &&
          Array.isArray(call.result.events) &&
          assistantAnswers(call.result.events, answer);
        await io.step("scoped_child_answer", async () => {
          if (
            reads.length < 1 ||
            reads.length > 20 ||
            reads.some((call) => call.input.sandboxId !== childId) ||
            !reads.some(answered)
          )
            fail("scoped_answer_unproven");
        });
        const stop = await io.step("scoped_child_stop", async () => {
          const call = stops[0];
          if (
            stops.length !== 1 ||
            !call ||
            call.input.idempotencyKey !== stopKey ||
            call.input.sandboxId !== childId ||
            call.result.sandboxId !== childId ||
            !successful(call) ||
            tools.some((tool) => !["launch", "message", "read", "stop"].includes(tool.name))
          )
            fail("scoped_stop_unproven");
          return call;
        });
        await io.step("scoped_child_order", async () => {
          if (
            !(
              tools.indexOf(verified.launch) < tools.indexOf(message) && tools.indexOf(message) < tools.indexOf(stop)
            ) ||
            !reads.some(
              (call) =>
                tools.indexOf(message) < tools.indexOf(call) &&
                tools.indexOf(call) < tools.indexOf(stop) &&
                answered(call),
            )
          )
            fail("scoped_order_unproven");
        });
      });
    },
    async cleanup(id: string | undefined, parentQuiesced: boolean): Promise<boolean> {
      return io.withCleanup(async () => {
        const parent = parentId ?? id;
        const unknownParent = !!parent && !parentQuiesced;
        let ok = !unknownParent;
        if (parent) {
          try {
            await io.step("scoped_parent_quiesced", async () => {
              if (!parentQuiesced) fail("scoped_parent_unquiesced");
            });
          } catch {
            ok = false;
          }
        }
        const leftover: string[] = [];
        const unverified: string[] = [];
        let unattributed: string[] = [];
        if (parent) {
          try {
            await logs(parent);
            evidenceUnknown = false;
          } catch {
            ok = false;
          }
          adopt();
        }
        let after: Set<string> | undefined;
        try {
          after = await snapshot();
        } catch {
          ok = false;
        }
        for (const childId of claims) {
          if (!before || !after?.has(childId) || before.has(childId) || childId === parent) {
            unverified.push(childId);
            ok = false;
            continue;
          }
          try {
            await io.step("scoped_child_cleanup", () => io.stopSandbox(childId));
          } catch {
            leftover.push(childId);
            ok = false;
          }
        }
        const baseline = before;
        if (baseline && after)
          unattributed = [...after].filter(
            (childId) => childId !== parent && !baseline.has(childId) && !claims.has(childId),
          );
        if (unattributed.length || sendUnknown || launchUnknown || evidenceUnknown) ok = false;
        io.out(
          JSON.stringify({
            step: "scoped_cleanup_summary",
            pass: ok,
            parentId: parent ?? null,
            mode: enabled ? "enabled" : "no_option",
            org: item.org,
            provider: item.provider,
            goldenId: item.goldenId,
            launchRequestKey: launchKey,
            operationIds: [...operations],
            claimedSandboxIds: [...claims],
            leftoverSandboxIds: leftover,
            unverifiedSandboxIds: unverified,
            unattributedSandboxIds: unattributed,
            parentQuiesced: parent ? parentQuiesced : null,
            unknownParent,
            unknownFutureChildren: unknownParent,
            unknownSend: sendUnknown,
            unknownLaunch: launchUnknown,
            unknownEvidence: evidenceUnknown,
          }),
        );
        return ok;
      });
    },
  };
}
