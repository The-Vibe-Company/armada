import { PRIVATE_SKILL_FAILURES } from "../packages/core/src/private-skill-error.ts";
import { TEMPLATE_REFUSAL_HELP } from "../packages/core/src/templates.ts";

/** API-only deployed template/skill checks. Readable canaries are never printed. */
export interface TemplateSkillCase {
  provider: "boat" | "modal";
  harness: "claude" | "codex";
  org: string;
  goldenId: string;
  model: string;
  modelAccountId: string;
  repo: string;
  reasoningEffort?: string;
  publicSkill?: string | undefined;
  privateSkill?: string | undefined;
}
export type TemplateSkillCode =
  | "invalid_response"
  | "template_launch_failed"
  | "template_answer_mismatch"
  | "template_exec_inherited"
  | "invalid_receipt"
  | "turn_failed"
  | "cleanup_unconfirmed";
export class TemplateSkillSmokeFailure extends Error {
  constructor(
    readonly code: TemplateSkillCode,
    readonly details: { state?: string; reason?: string } = {},
  ) {
    super(code);
  }
}
const REFUSALS = new Set<string>([
  ...Object.keys(TEMPLATE_REFUSAL_HELP),
  ...PRIVATE_SKILL_FAILURES,
  "skillpack_credential_missing",
  "skillpack_credential_refused",
  "skillpack_skill_unavailable",
  "allocation_or_start_unknown",
  "launch_unavailable",
]);
function launchFailure(state: unknown, reason: unknown): never {
  throw new TemplateSkillSmokeFailure("template_launch_failed", {
    state:
      typeof state === "string" && ["claimed", "allocating", "failed", "reconciling"].includes(state)
        ? state
        : "unknown",
    reason: typeof reason === "string" && REFUSALS.has(reason) ? reason : "unrecognized_refusal",
  });
}
function fail(code: TemplateSkillCode): never {
  throw new TemplateSkillSmokeFailure(code);
}
export interface TemplateSkillIo {
  request<T>(path: string, body: object): Promise<T>;
  poll<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T>;
  step<T>(name: string, action: () => Promise<T>): Promise<T>;
  out(line: string): void;
  stopSandbox(id: string): Promise<void>;
  withCleanup<T>(action: () => Promise<T>): Promise<T>;
}
type Metadata = { id?: string; kind?: string; version?: number };
type Connections = { user: Metadata[]; orgs: { id: string; credentials: Metadata[] }[] };
type Resource = { id: string; version: number };
type Template = { id: string; currentRevision: number; name?: string };
type Receipt = { reference: string; version: string; skillId: string; checksum: string; origin: string };
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function metadata(value: Connections, org: string): Metadata[] {
  if (!Array.isArray(value?.user) || !Array.isArray(value.orgs)) fail("invalid_response");
  const selected = value.orgs.filter((entry) => entry?.id === org);
  if (selected.length !== 1 || !Array.isArray(selected[0]?.credentials)) fail("invalid_response");
  const rows = [...value.user, ...selected[0].credentials];
  if (rows.some((entry) => !entry || typeof entry.kind !== "string")) fail("invalid_response");
  return rows;
}
function verifyReceipts(receipts: unknown, pins: string[]): asserts receipts is Receipt[] {
  if (!Array.isArray(receipts) || receipts.length !== pins.length) fail("invalid_receipt");
  for (const pin of pins) {
    const found = receipts.filter((receipt) => receipt?.reference === pin);
    if (found.length !== 1) fail("invalid_receipt");
    const receipt = found[0];
    if (
      receipt.version !== pin.split("@")[1] ||
      typeof receipt.skillId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(receipt.skillId) ||
      typeof receipt.checksum !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(receipt.checksum) ||
      receipt.origin !== "https://skillpack.app/v1"
    )
      fail("invalid_receipt");
  }
}

/** One pair: readable launch with optional public pin, then configured private-pin launch. */
export async function runTemplateSkillCase(item: TemplateSkillCase, io: TemplateSkillIo): Promise<boolean> {
  const run = crypto.randomUUID().replaceAll("-", "");
  const key = `SMOKE_VALUE_${run.toUpperCase()}`;
  const value = `smoke-${crypto.randomUUID()}`;
  let variable: Resource | undefined;
  let variableAttempted = false;
  let passed = true;
  const templates: {
    name: string;
    attempted: boolean;
    resource?: Template;
    sandboxId?: string;
    launchAttempted: boolean;
    requestKey: string;
    requestId?: string;
    uncertain: boolean;
    stopConfirmed: boolean;
  }[] = [];
  const api = <T>(path: string, body: object = {}) => io.request<T>(path, { org: item.org, ...body });
  async function cleanup(name: string, action: () => Promise<void>) {
    try {
      await io.step(name, action);
      return true;
    } catch {
      passed = false;
      return false;
    }
  }
  try {
    const account = await io.step("template_model_account", async () => {
      const rows = metadata(await api<Connections>("creds/list"), item.org);
      const matches = rows.filter((row) => row.id === item.modelAccountId);
      if (matches.length !== 1 || !positive(matches[0]?.version)) fail("invalid_response");
      return { id: item.modelAccountId, version: matches[0].version };
    });
    const privateConfigured = item.privateSkill
      ? await io.step("private_skill_configuration", async () =>
          metadata(await api<Connections>("skillpack/connection"), item.org).some((row) => row.kind === "skillpack"),
        )
      : false;
    if (!item.publicSkill)
      io.out(JSON.stringify({ step: "public_skill", skip: true, reason: "skill_pin_not_configured" }));
    if (!item.privateSkill)
      io.out(JSON.stringify({ step: "private_skill", skip: true, reason: "skill_pin_not_configured" }));
    await io.step("template_variable_create", async () => {
      variableAttempted = true;
      const result = await api<{ item: Resource }>("variables/set", { scope: "personal", name: key, value });
      if (typeof result?.item?.id === "string" && result.item.id) variable = result.item;
      if (!variable || !positive(variable.version)) fail("invalid_response");
    });
    async function launch(kind: "public" | "private", pin?: string) {
      const label = kind === "public" ? "template" : "private_skill";
      const record: (typeof templates)[number] = {
        name: `smoke-${run}-${kind}`,
        attempted: false,
        launchAttempted: false,
        requestKey: `smoke-${run}-${kind}`,
        uncertain: false,
        stopConfirmed: false,
      };
      templates.push(record);
      await io.step(`${label}_create`, async () => {
        record.attempted = true;
        const result = await api<{ item: Template }>("templates/create", {
          name: record.name,
          scope: "personal",
          definition: {
            goldenId: item.goldenId,
            provider: item.provider,
            harness: item.harness,
            model: item.model,
            modelAccount: account,
            ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
            connections: [],
            skills: pin ? [pin] : [],
            variables: [{ key, variableId: variable!.id, version: variable!.version }],
          },
        });
        if (typeof result?.item?.id === "string" && result.item.id) record.resource = result.item;
        if (!record.resource || !positive(record.resource.currentRevision)) fail("invalid_response");
      });
      const result = await io.step(`${label}_launch`, async () => {
        record.launchAttempted = true;
        record.uncertain = true;
        const result = await api<{
          state: string;
          reason?: unknown;
          requestId?: string;
          id?: string;
          promptId?: string;
          provider?: string;
          manifest?: { skillReceipts?: unknown };
        }>("templates/launch", {
          id: record.resource!.id,
          revision: record.resource!.currentRevision,
          requestKey: record.requestKey,
          ttlSeconds: 900,
          prompt: `Read the environment variable ${key} using your terminal tool. Reply with only its exact value, with no formatting or other text. Do not modify files.`,
        });
        if (typeof result?.id === "string" && result.id) record.sandboxId = result.id;
        if (typeof result?.requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(result.requestId))
          record.requestId = result.requestId;
        record.uncertain = result?.state !== "succeeded" && result?.state !== "failed";
        if (result?.state !== "succeeded") launchFailure(result?.state, result?.reason);
        if (
          !record.sandboxId ||
          result.provider !== item.provider ||
          typeof result.promptId !== "string" ||
          !result.promptId
        )
          fail("invalid_response");
        return result;
      });
      if (pin)
        await io.step(`${kind}_skill_receipt`, async () => {
          verifyReceipts(result.manifest?.skillReceipts, [pin]);
          const status = await api<{ skills?: unknown }>("sandbox/status", { id: record.sandboxId });
          verifyReceipts(status.skills, [pin]);
          for (const field of ["reference", "version", "skillId", "checksum", "origin"] as const)
            if (result.manifest!.skillReceipts[0]?.[field] !== status.skills[0]?.[field]) fail("invalid_receipt");
        });
      await io.step(`${label}_wait`, () =>
        io.poll(
          () =>
            api<{ prompt: { promptId: string; state: string } | null }>("sandbox/wait", {
              id: record.sandboxId,
              prompt_id: result.promptId,
              timeout_seconds: 0,
            }),
          (status) => {
            if (!status?.prompt || status.prompt.promptId !== result.promptId) fail("invalid_response");
            if (status.prompt.state === "failed" || status.prompt.state === "interrupted") fail("turn_failed");
            if (status.prompt.state !== "running" && status.prompt.state !== "finished") fail("invalid_response");
            return status.prompt.state === "finished";
          },
        ),
      );
      await io.step(`${label}_answer`, async () => {
        type Event = {
          id: string;
          kind: string;
          promptId?: string;
          text?: string;
          partial?: boolean;
          responseKind?: string;
          retracted?: boolean;
          parentToolUseId?: string | null;
          messageId?: string;
          textMode?: string;
        };
        const events = new Map<string, Event>();
        let cursor: string | undefined;
        const cursors = new Set<string>();
        for (let pageIndex = 0; pageIndex < 120; pageIndex++) {
          const page = await api<{ events: Event[]; cursor: string | null; hasMore: boolean }>("logs/read", {
            id: record.sandboxId,
            limit: 100,
            coalesce: true,
            ...(cursor ? { cursor } : {}),
          });
          if (!Array.isArray(page?.events) || typeof page.hasMore !== "boolean") fail("invalid_response");
          for (const event of page.events) {
            if (typeof event?.id !== "string") fail("invalid_response");
            events.set(event.id, event);
          }
          if (!page.hasMore) break;
          if (!page.cursor || cursors.has(page.cursor)) fail("invalid_response");
          cursor = page.cursor;
          cursors.add(cursor);
          if (pageIndex === 119) fail("invalid_response");
        }
        const messages = new Map<string, { text: string; partial: boolean }>();
        for (const event of events.values()) {
          if (
            event.kind !== "message" ||
            event.promptId !== result.promptId ||
            event.responseKind === "tool_result" ||
            event.parentToolUseId ||
            event.retracted
          )
            continue;
          if (typeof event.text !== "string" || typeof event.partial !== "boolean") fail("invalid_response");
          const id = event.messageId ?? event.id;
          const previous = messages.get(id);
          messages.set(id, {
            text: event.textMode === "delta" ? (previous?.text ?? "") + event.text : event.text,
            partial: event.partial,
          });
        }
        const final = [...messages.values()].filter((message) => !message.partial && message.text.length).at(-1);
        if (final?.text !== value) fail("template_answer_mismatch");
      });
      await io.step(`${label}_exec_isolation`, async () => {
        const result = await api<{ exitCode: number | null; timedOut: boolean }>("sandbox/exec", {
          id: record.sandboxId,
          cwd: item.repo,
          timeout_seconds: 30,
          command: `test "\${${key}+present}" != present`,
        });
        if (result?.exitCode !== 0 || result.timedOut !== false) fail("template_exec_inherited");
      });
    }
    await launch("public", item.publicSkill);
    if (item.privateSkill && privateConfigured) await launch("private", item.privateSkill);
    else if (item.privateSkill)
      io.out(JSON.stringify({ step: "private_skill", skip: true, reason: "skillpack_key_not_configured" }));
  } catch {
    passed = false;
  } finally {
    await io.withCleanup(async () => {
      for (const record of templates.toReversed()) {
        if (record.sandboxId)
          record.stopConfirmed = await cleanup("cleanup_template_sandbox", () => io.stopSandbox(record.sandboxId!));
        else if (record.launchAttempted)
          await cleanup("cleanup_template_sandbox", async () => fail("cleanup_unconfirmed"));
        if (!record.resource && record.attempted)
          await cleanup("reconcile_template", async () => {
            const list = await api<{ items: Template[] }>("templates/list");
            if (!Array.isArray(list?.items)) fail("invalid_response");
            const found = list.items.filter((entry) => entry.name === record.name);
            if (found.length > 1) fail("cleanup_unconfirmed");
            if (found[0]) record.resource = found[0];
          });
        if (record.resource)
          await cleanup("cleanup_template", async () => {
            const result = await api<{ item: { status: string } }>("templates/delete", {
              id: record.resource!.id,
              expectedRevision: record.resource!.currentRevision,
            });
            if (result?.item?.status !== "deleted") fail("cleanup_unconfirmed");
          });
      }
      if (!variable && variableAttempted)
        await cleanup("reconcile_template_variable", async () => {
          const list = await api<{ items: (Resource & { name: string })[] }>("variables/list");
          if (!Array.isArray(list?.items)) fail("invalid_response");
          const found = list.items.filter((entry) => entry.name === key);
          if (found.length > 1) fail("cleanup_unconfirmed");
          if (found[0]) variable = found[0];
        });
      if (variable)
        await cleanup("cleanup_template_variable", async () => {
          const result = await api<{ item: { status: string } }>("variables/delete", {
            id: variable!.id,
            expectedVersion: variable!.version,
          });
          if (result?.item?.status !== "deleted") fail("cleanup_unconfirmed");
        });
    });
    const leftoverSandboxIds = templates
      .filter((record) => record.sandboxId && !record.stopConfirmed)
      .map((record) => record.sandboxId);
    const uncertainLaunches = templates
      .filter((record) => record.uncertain)
      .map((record) => ({
        templateId: record.resource?.id ?? null,
        templateName: record.name,
        requestKey: record.requestKey,
        ...(record.requestId ? { requestId: record.requestId } : {}),
        ...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
      }));
    io.out(
      JSON.stringify({
        step: "template_cleanup_summary",
        pass: !leftoverSandboxIds.length && !uncertainLaunches.length,
        leftoverSandboxIds,
        uncertainLaunches,
      }),
    );
  }
  return passed;
}
