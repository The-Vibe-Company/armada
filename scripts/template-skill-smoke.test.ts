import { expect, test } from "bun:test";
import {
  runTemplateSkillCase,
  type TemplateSkillCase,
  type TemplateSkillIo,
  TemplateSkillSmokeFailure,
} from "./template-skill-smoke.ts";

const selected = {
  provider: "boat",
  harness: "codex",
  org: "org",
  goldenId: "golden",
  model: "model",
  modelAccountId: "account",
  repo: "/home/user/repo",
  publicSkill: "example/review@1.0.0",
  privateSkill: "notes@2.0.0",
} satisfies TemplateSkillCase;
type Fault =
  | "none"
  | "answer"
  | "wrong_turn"
  | "tool_result"
  | "partial"
  | "exec"
  | "missing_receipt"
  | "mismatched_receipt"
  | "key_refused"
  | "bad_metadata"
  | "no_account"
  | "lost_launch"
  | "lost_template"
  | "lost_variable"
  | "cleanup"
  | "uncertain_launch"
  | "missing_handle";
function fixture(
  options: { key?: "user" | "org" | "absent"; fault?: Fault; splitAnswer?: boolean; refusalReason?: string } = {},
) {
  const { key = "user", fault = "none", splitAnswer = false } = options;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const lines: {
    step: string;
    pass?: boolean;
    skip?: boolean;
    reason?: string;
    code?: string;
    state?: string;
    leftoverSandboxIds?: string[];
    uncertainLaunches?: { templateId: string; templateName: string; requestKey: string; requestId?: string }[];
  }[] = [];
  const stopped: string[] = [];
  let cleaning = false;
  let variable: { id: string; version: number; name: string; value: string } | undefined;
  const templates: {
    id: string;
    currentRevision: number;
    name: string;
    definition: { skills: string[]; modelAccount: { id: string; version: number } };
  }[] = [];
  let creates = 0;
  const receipt = (pin: string) => ({
    reference: pin,
    version: pin.split("@")[1],
    skillId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    checksum: `sha256:${"a".repeat(64)}`,
    origin: "https://skillpack.app/v1",
  });
  const io: TemplateSkillIo = {
    async request<T>(path: string, body: object) {
      const input = body as Record<string, unknown>;
      calls.push({ path, body: input });
      expect(input.org).toBe(selected.org);
      let output: unknown;
      if (path === "creds/list")
        output = {
          user: fault === "no_account" ? [] : [{ id: selected.modelAccountId, kind: "openai", version: 7 }],
          orgs: [{ id: selected.org, credentials: [] }],
        };
      else if (path === "skillpack/connection")
        output =
          fault === "bad_metadata"
            ? {}
            : {
                user: key === "user" ? [{ kind: "skillpack" }] : [],
                orgs: [{ id: selected.org, credentials: key === "org" ? [{ kind: "skillpack" }] : [] }],
              };
      else if (path === "variables/set") {
        variable = { id: "variable", version: 1, name: String(input.name), value: String(input.value) };
        if (fault === "lost_variable") throw new Error("secret failed variable receipt");
        output = { item: variable };
      } else if (path === "templates/create") {
        const template = {
          id: `template-${++creates}`,
          currentRevision: 1,
          name: String(input.name),
          definition: input.definition as (typeof templates)[number]["definition"],
        };
        templates.push(template);
        if (fault === "lost_template") throw new Error("secret failed template receipt");
        output = { item: template };
      } else if (path === "templates/launch") {
        const template = templates.find((item) => item.id === input.id);
        const pin = template?.definition.skills[0];
        if (!template || !variable) throw new Error("Unexpected launch fixture");
        expect(template?.definition.modelAccount).toEqual({ id: selected.modelAccountId, version: 7 });
        expect(String(input.prompt)).toContain(variable.name);
        expect(String(input.prompt)).not.toContain(variable.value);
        expect(input).not.toHaveProperty("repo");
        if (fault === "lost_launch") throw new Error("secret lost compute receipt");
        output =
          (fault === "key_refused" && pin === selected.privateSkill) || fault === "uncertain_launch"
            ? {
                state: fault === "uncertain_launch" ? "reconciling" : "failed",
                id: `sandbox-${template.id}`,
                requestId: "request-1",
                reason:
                  options.refusalReason ??
                  (fault === "uncertain_launch" ? "allocation_or_start_unknown" : "skillpack_credential_refused"),
              }
            : {
                state: "succeeded",
                ...(fault === "missing_handle" ? {} : { id: `sandbox-${template.id}` }),
                provider: selected.provider,
                promptId: `prompt-${template.id}`,
                manifest: { skillReceipts: fault === "missing_receipt" || !pin ? [] : [receipt(pin)] },
              };
      } else if (path === "sandbox/status") {
        const template = templates.find((item) => `sandbox-${item.id}` === input.id);
        output = {
          skills: [receipt(fault === "mismatched_receipt" ? selected.privateSkill : template!.definition.skills[0]!)],
        };
      } else if (path === "sandbox/wait") output = { prompt: { promptId: input.prompt_id, state: "finished" } };
      else if (path === "logs/read") {
        expect(input).not.toHaveProperty("since_cursor");
        if (input.cursor !== undefined) expect(input.cursor).toBe("next");
        const prompt = `prompt-${String(input.id).replace("sandbox-", "")}`;
        const text = fault === "answer" ? "not-the-value" : variable!.value;
        if (splitAnswer && !input.cursor)
          output = {
            events: [
              {
                id: "first",
                messageId: "answer",
                kind: "message",
                promptId: prompt,
                text: text.slice(0, 7),
                textMode: "snapshot",
                partial: true,
              },
            ],
            cursor: "next",
            hasMore: true,
          };
        else
          output = {
            events: [
              {
                id: "final",
                messageId: "answer",
                kind: "message",
                promptId: fault === "wrong_turn" ? "different" : prompt,
                text: splitAnswer ? text.slice(7) : text,
                textMode: splitAnswer ? "delta" : "snapshot",
                partial: fault === "partial",
                responseKind: fault === "tool_result" ? "tool_result" : "assistant",
              },
            ],
            cursor: "end",
            hasMore: false,
          };
      } else if (path === "sandbox/exec") {
        expect(String(input.command)).toBe(`test "\${${variable!.name}+present}" != present`);
        expect(String(input.command)).not.toContain(variable!.value);
        output = { exitCode: fault === "exec" ? 1 : 0, timedOut: false };
      } else if (path === "templates/list") {
        expect(cleaning).toBe(true);
        output = { items: templates };
      } else if (path === "variables/list") {
        expect(cleaning).toBe(true);
        output = { items: variable ? [variable] : [] };
      } else if (path === "templates/delete" || path === "variables/delete") {
        expect(cleaning).toBe(true);
        output = { item: { status: "deleted" } };
      } else throw new Error(`Unexpected fixture route ${path}`);
      return output as T;
    },
    async poll<T>(read: () => Promise<T>, done: (value: T) => boolean) {
      for (let i = 0; i < 3; i++) {
        const value = await read();
        if (done(value)) return value;
      }
      throw new Error("poll limit");
    },
    async step<T>(step: string, action: () => Promise<T>) {
      try {
        const result = await action();
        lines.push({ step, pass: true });
        return result;
      } catch (error) {
        lines.push({
          step,
          pass: false,
          code: error instanceof TemplateSkillSmokeFailure ? error.code : "api_failed",
          ...(error instanceof TemplateSkillSmokeFailure ? error.details : {}),
        });
        throw error;
      }
    },
    out(line: string) {
      lines.push(JSON.parse(line));
    },
    async stopSandbox(id: string) {
      expect(cleaning).toBe(true);
      stopped.push(id);
      if (fault === "cleanup") throw new Error("secret stop refusal");
    },
    async withCleanup<T>(action: () => Promise<T>) {
      cleaning = true;
      try {
        return await action();
      } finally {
        cleaning = false;
      }
    },
  };
  return { io, calls, lines, stopped, value: () => variable?.value };
}

test("template smoke pins the selected account, checks exact paginated assistant answer and both receipt copies, then cleans all resources", async () => {
  for (const key of ["user", "org"] as const) {
    const fake = fixture({ key, splitAnswer: true });
    expect(await runTemplateSkillCase(selected, fake.io)).toBe(true);
    expect(fake.calls.filter((call) => call.path === "templates/launch")).toHaveLength(2);
    expect(fake.stopped).toEqual(["sandbox-template-2", "sandbox-template-1"]);
    expect(fake.calls.filter((call) => call.path === "templates/delete")).toHaveLength(2);
    expect(fake.calls.at(-1)).toEqual({
      path: "variables/delete",
      body: { org: selected.org, id: "variable", expectedVersion: 1 },
    });
    expect(fake.lines).toContainEqual({ step: "public_skill_receipt", pass: true });
    expect(fake.lines).toContainEqual({ step: "private_skill_receipt", pass: true });
    expect(JSON.stringify(fake.lines)).not.toContain(fake.value());
    expect(JSON.stringify(fake.lines)).not.toContain("secret");
  }
});

test("only confirmed absent Skillpack key skips private pin; malformed metadata or configured-but-refused keys fail", async () => {
  for (const fault of ["none", "bad_metadata", "key_refused", "no_account"] as const) {
    const fake = fixture({ key: fault === "key_refused" ? "user" : "absent", fault });
    expect(await runTemplateSkillCase(selected, fake.io)).toBe(fault === "none");
    if (fault === "none") {
      expect(fake.calls.filter((call) => call.path === "templates/launch")).toHaveLength(1);
      expect(fake.lines).toContainEqual({ step: "private_skill", skip: true, reason: "skillpack_key_not_configured" });
    } else expect(fake.lines.some((line) => line.skip)).toBe(false);
    if (fault === "key_refused")
      expect(fake.lines).toContainEqual({
        step: "private_skill_launch",
        pass: false,
        code: "template_launch_failed",
        state: "failed",
        reason: "skillpack_credential_refused",
      });
    if (fault === "bad_metadata" || fault === "no_account")
      expect(fake.calls.some((call) => call.path === "variables/set")).toBe(false);
  }
});

test("template smoke fails closed on wrong answers, non-final/non-assistant evidence, inherited exec values or invalid receipts and still cleans", async () => {
  for (const fault of [
    "answer",
    "wrong_turn",
    "tool_result",
    "partial",
    "exec",
    "missing_receipt",
    "mismatched_receipt",
  ] as const) {
    const fake = fixture({ key: "absent", fault });
    expect(await runTemplateSkillCase(selected, fake.io)).toBe(false);
    expect(fake.stopped).toEqual(["sandbox-template-1"]);
    expect(fake.calls.some((call) => call.path === "templates/delete")).toBe(true);
    expect(fake.calls.at(-1)?.path).toBe("variables/delete");
    expect(JSON.stringify(fake.lines)).not.toContain(fake.value());
    expect(fake.lines).toContainEqual(
      expect.objectContaining({
        pass: false,
        code: fault.includes("receipt")
          ? "invalid_receipt"
          : fault === "exec"
            ? "template_exec_inherited"
            : "template_answer_mismatch",
      }),
    );
  }
});

test("lost metadata receipts reconcile by unique run name; lost compute is never retried and cleanup failures do not strand other metadata", async () => {
  for (const fault of [
    "lost_variable",
    "lost_template",
    "lost_launch",
    "cleanup",
    "uncertain_launch",
    "missing_handle",
  ] as const) {
    const fake = fixture({ fault, key: "absent" });
    expect(await runTemplateSkillCase(selected, fake.io)).toBe(false);
    expect(fake.calls.filter((call) => call.path === "templates/launch").length).toBeLessThanOrEqual(1);
    if (fault === "lost_launch")
      expect(fake.lines).toContainEqual({ step: "cleanup_template_sandbox", pass: false, code: "cleanup_unconfirmed" });
    const summary = fake.lines.find((line) => line.step === "template_cleanup_summary");
    expect(summary).toBeDefined();
    if (fault === "cleanup") expect(summary?.leftoverSandboxIds).toEqual(["sandbox-template-1"]);
    if (fault === "lost_launch" || fault === "uncertain_launch" || fault === "missing_handle") {
      const launch = fake.calls.find((call) => call.path === "templates/launch")!;
      expect(summary?.uncertainLaunches).toContainEqual(
        expect.objectContaining({
          templateId: launch.body.id,
          requestKey: launch.body.requestKey,
          ...(fault === "uncertain_launch" ? { requestId: "request-1" } : {}),
        }),
      );
      expect(fake.calls.filter((call) => call.path === "templates/launch")).toHaveLength(1);
    }
    if (fault === "lost_variable") expect(fake.calls.some((call) => call.path === "variables/list")).toBe(true);
    if (fault === "lost_template") expect(fake.calls.some((call) => call.path === "templates/list")).toBe(true);
    if (fault !== "lost_variable") expect(fake.calls.some((call) => call.path === "templates/delete")).toBe(true);
    expect(fake.calls.at(-1)?.path).toBe("variables/delete");
    expect(JSON.stringify(fake.lines)).not.toContain("secret");
    expect(JSON.stringify(fake.lines)).not.toContain(fake.value());
  }
});

test("missing pins explicitly skip their checks while the template variable still reaches the agent", async () => {
  for (const missing of ["public", "private", "both"] as const) {
    const fake = fixture();
    const item = {
      ...selected,
      ...(missing !== "private" ? { publicSkill: undefined } : {}),
      ...(missing !== "public" ? { privateSkill: undefined } : {}),
    };
    expect(await runTemplateSkillCase(item, fake.io)).toBe(true);
    for (const kind of ["public", "private"] as const) {
      if (item[`${kind}Skill`] === undefined)
        expect(fake.lines).toContainEqual({ step: `${kind}_skill`, skip: true, reason: "skill_pin_not_configured" });
    }
    expect(fake.lines).toContainEqual({ step: "template_answer", pass: true });
    expect(fake.lines).toContainEqual({ step: "template_exec_isolation", pass: true });
    expect(fake.calls.filter((call) => call.path === "templates/launch")).toHaveLength(item.privateSkill ? 2 : 1);
    if (!item.privateSkill) expect(fake.calls.some((call) => call.path === "skillpack/connection")).toBe(false);
    expect(JSON.stringify(fake.lines)).not.toContain(fake.value());
  }
});

test("launch refusal diagnostics drop arbitrary remote text but retain closed uncertainty states", async () => {
  const fake = fixture({ fault: "key_refused", refusalReason: "secret-provider-detail" });
  expect(await runTemplateSkillCase(selected, fake.io)).toBe(false);
  expect(fake.lines).toContainEqual({
    step: "private_skill_launch",
    pass: false,
    code: "template_launch_failed",
    state: "failed",
    reason: "unrecognized_refusal",
  });
  expect(JSON.stringify(fake.lines)).not.toContain("secret-provider-detail");
});
