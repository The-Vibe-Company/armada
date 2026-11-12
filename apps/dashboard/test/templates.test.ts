import { describe, expect, test } from "bun:test";
import { createTemplateControl } from "../src/lib/control.ts";
import { launchTarget } from "../src/lib/template-launch.ts";
import {
  agentSummary,
  canManageTemplate,
  parseLaunchOutcome,
  parseRevision,
  parseTemplate,
  type TemplateFormFields,
  type TemplateLookups,
  templateFailure,
  templateRequest,
  templateState,
  ttlChoice,
  ttlOptions,
} from "../src/lib/templates.ts";

const ORG = "00000000-0000-4000-8000-000000000010";
const ALICE = "00000000-0000-4000-8000-000000000001";
const TEMPLATE = "00000000-0000-4000-8000-000000000090";
const SHARED = "00000000-0000-4000-8000-000000000020";
const PRIVATE = "00000000-0000-4000-8000-000000000021";
const DOCS = "00000000-0000-4000-8000-000000000060";
const MINE = "00000000-0000-4000-8000-000000000061";
const REGION = "00000000-0000-4000-8000-000000000080";
const NOTES = "00000000-0000-4000-8000-000000000084";

const header = {
  id: TEMPLATE,
  orgId: ORG,
  ownerId: ALICE,
  scope: "org",
  name: "Backend",
  currentRevision: 2,
  status: "active",
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-11T10:00:00.000Z",
};
const definition = {
  goldenId: SHARED,
  provider: "boat",
  goldenBinding: null,
  harness: "claude",
  model: "claude-opus-5-5",
  reasoningEffort: "high",
  connections: [DOCS],
  variables: [{ key: "APP_REGION", variableId: REGION, version: 3 }],
  skills: [],
};
const revision = { id: "00000000-0000-4000-8000-000000000099", revision: 2, definition };

const lookups: TemplateLookups = {
  goldens: [
    { id: SHARED, name: "shared", provider: "boat", visibility: "org", ready: true },
    { id: PRIVATE, name: "mine", provider: "boat", visibility: "private", ready: false },
  ],
  connections: [
    { id: DOCS, name: "Docs", scope: "org", status: "connected" },
    { id: MINE, name: "Linear", scope: "personal", status: "needs_reconnect" },
  ],
  variables: [
    { id: REGION, name: "APP_REGION", scope: "org", version: 3, status: "active" },
    { id: NOTES, name: "NOTES_URL", scope: "personal", version: 1, status: "active" },
  ],
};

const form = (fields: Partial<TemplateFormFields> = {}): TemplateFormFields => ({
  name: " Backend ",
  scope: "personal",
  goldenId: SHARED,
  harness: "claude",
  model: "claude-opus-5-5",
  otherModel: "",
  reasoningEffort: "high",
  connections: [],
  variables: [],
  skills: [],
  ...fields,
});

describe("template DTOs", () => {
  test("a header and a revision keep only their known fields; a deleted or malformed one is dropped", () => {
    expect(parseTemplate({ ...header, extra: "x" })).toEqual({
      id: TEMPLATE,
      orgId: ORG,
      ownerId: ALICE,
      scope: "org",
      name: "Backend",
      currentRevision: 2,
      createdAt: header.createdAt,
      updatedAt: header.updatedAt,
    });
    expect(parseTemplate({ ...header, status: "deleted" })).toBeNull();
    expect(parseTemplate({ ...header, currentRevision: 0 })).toBeNull();
    const parsed = parseRevision({ ...revision, definition: { ...definition, secrets: [] } });
    expect(parsed?.definition).toEqual({
      goldenId: SHARED,
      provider: "boat",
      harness: "claude",
      model: "claude-opus-5-5",
      reasoningEffort: "high",
      connections: [DOCS],
      variables: [{ key: "APP_REGION", variableId: REGION, version: 3 }],
      skills: [],
    });
    expect(parseRevision({ ...revision, definition: { ...definition, harness: "other" } })).toBeNull();
  });

  test("a launch answer is a sandbox, a definite refusal, or an outcome not known yet", () => {
    expect(parseLaunchOutcome({ state: "succeeded", id: REGION, manifest: { variables: { A: "v" } } })).toEqual({
      state: "succeeded",
      id: REGION,
    });
    expect(parseLaunchOutcome({ state: "failed", reason: "variable_unavailable" })).toEqual({
      state: "failed",
      reason: "variable_unavailable",
    });
    expect(parseLaunchOutcome({ state: "allocating", id: REGION })).toEqual({ state: "reconciling", id: REGION });
    expect(parseLaunchOutcome(null)).toBeNull();
  });
});

describe("template state", () => {
  const item = (def: Partial<typeof definition>) => ({
    revision: parseRevision({ ...revision, definition: { ...definition, ...def } }),
  });

  test("ready when every reference is usable; a list that could not be read raises nothing", () => {
    expect(templateState(item({}), lookups).label).toBe("Ready");
    expect(templateState(item({ connections: [MINE], variables: [] }), { ...lookups, connections: null }).label).toBe(
      "Ready",
    );
  });

  test("says what needs the viewer first: environment, then tool, then variable", () => {
    const stale = templateState(
      item({
        variables: [
          { key: "APP_REGION", variableId: REGION, version: 2 },
          { key: "FALLBACK_REGION", variableId: REGION, version: 2 },
        ],
      }),
      lookups,
    );
    // Two aliases of the same stale source require the same single revision fix, not duplicate warnings.
    expect(stale.problems).toHaveLength(1);
    expect(stale).toMatchObject({ bucket: "action", tone: "warning", label: "Variable changed" });
    expect(stale.problems[0]?.text).toContain("publish a new revision");
    expect(templateState(item({ connections: [MINE] }), lookups).label).toBe("Tool not ready");
    expect(templateState(item({ goldenId: PRIVATE }), lookups).label).toBe("Environment unavailable");
    expect(templateState({ revision: null }, lookups)).toMatchObject({ bucket: "rest", label: "Details unavailable" });
  });

  test("the agent summary and who may change it", () => {
    expect(agentSummary({ harness: "claude", model: "claude-opus-5-5", reasoningEffort: "xhigh" })).toBe(
      "Claude Code · Claude Opus 5.5 · Extra high",
    );
    expect(canManageTemplate({ scope: "org", ownerId: ALICE }, { userId: "other", admin: true })).toBe(true);
    expect(canManageTemplate({ scope: "org", ownerId: ALICE }, { userId: ALICE, admin: false })).toBe(false);
    expect(canManageTemplate({ scope: "personal", ownerId: ALICE }, { userId: "other", admin: true })).toBe(false);
  });
});

describe("template form", () => {
  test("builds the control API request, binding each variable under its name at its current version", () => {
    const parsed = templateRequest(form({ connections: [DOCS, DOCS], variables: [REGION] }), lookups);
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: "Backend",
        scope: "personal",
        definition: {
          goldenId: SHARED,
          provider: "boat",
          harness: "claude",
          model: "claude-opus-5-5",
          reasoningEffort: "high",
          connections: [DOCS],
          variables: [{ key: "APP_REGION", variableId: REGION, version: 3 }],
        },
      },
    });
  });

  test("publishes explicit exact skills, preserving an edited revision until the person changes or clears them", () => {
    const skills = ["team/testing@1.2.3", "review-code@2.1.0"];
    const previous = { connections: [], variables: [], skills };
    for (const selected of [skills, ["review-code@2.0.0"], []]) {
      const parsed = templateRequest(form({ skills: selected, reasoningEffort: "medium" }), lookups, previous);
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && (parsed.value.definition.skills ?? [])).toEqual(selected);
    }
    expect(previous.skills).toEqual(["team/testing@1.2.3", "review-code@2.1.0"]);
  });

  test("invalid template skills are refused before immutable publication", () => {
    for (const skills of [
      ["review-code@latest"],
      ["review-code@^2.0.0"],
      ["team/armada-tools@1.0.0"],
      ["armada-tools@1.0.0"],
      ["review-code@2.1.0", "team/review-code@2.0.0"],
      ["review-code@2.1.0", "review-code@2.1.0"],
      Array.from({ length: 21 }, (_, index) => `skill-${index}@1.0.0`),
    ]) {
      expect(templateRequest(form({ skills }), lookups)).toEqual({
        ok: false,
        error: "Choose at most 20 distinct skills pinned to exact versions. Armada tools are managed automatically.",
      });
    }
  });

  test("refuses in words what the server would refuse", () => {
    const error = (fields: Partial<TemplateFormFields>) => {
      const parsed = templateRequest(form(fields), lookups);
      return parsed.ok ? null : parsed.error;
    };
    expect(error({ name: "  " })).toBe("Name the template.");
    expect(error({ goldenId: "" })).toBe("Choose an environment.");
    expect(error({ goldenId: PRIVATE })).toContain("no snapshot yet");
    expect(error({ harness: "other" })).toBe("Choose Claude Code or Codex.");
    expect(error({ connections: [MINE] })).toContain("Linear is not connected");
    expect(error({ scope: "org", variables: [NOTES] })).toContain("NOTES_URL is personal");
    expect(error({ scope: "org", goldenId: PRIVATE })).not.toBeNull();
    expect(error({ variables: [REGION], connections: [DOCS] })).toBeNull();
  });
});

describe("template revision from the form", () => {
  const previous = {
    connections: [DOCS],
    variables: [{ key: "DEPLOY_REGION", variableId: REGION, version: 2 }],
  };

  test("a variable the revision binds under another key keeps that key; a new one takes its name", () => {
    const parsed = templateRequest(form({ connections: [DOCS], variables: [REGION, NOTES] }), lookups, previous);
    expect(parsed.ok && parsed.value.definition.variables).toEqual([
      { key: "DEPLOY_REGION", variableId: REGION, version: 3 },
      { key: "NOTES_URL", variableId: NOTES, version: 1 },
    ]);
  });

  test("every key bound to one variable is kept, not collapsed to the first", () => {
    const twice = {
      connections: [],
      variables: [
        { key: "DEPLOY_REGION", variableId: REGION, version: 2 },
        { key: "FALLBACK_REGION", variableId: REGION, version: 2 },
      ],
    };
    const parsed = templateRequest(form({ variables: [REGION] }), lookups, twice);
    expect(parsed.ok && parsed.value.definition.variables).toEqual([
      { key: "DEPLOY_REGION", variableId: REGION, version: 3 },
      { key: "FALLBACK_REGION", variableId: REGION, version: 3 },
    ]);
  });

  test("a list that cannot be read blocks the revision instead of dropping its selections", () => {
    const tools = templateRequest(form({ variables: [REGION] }), { ...lookups, connections: null }, previous);
    expect(tools).toEqual({
      ok: false,
      error: "Tools could not be read, so this revision's tools would be lost. Refresh and try again.",
    });
    const variables = templateRequest(form({ connections: [DOCS] }), { ...lookups, variables: null }, previous);
    expect(variables.ok ? null : variables.error).toContain("variables would be lost");
    // A new template has nothing to lose.
    expect(templateRequest(form(), { ...lookups, connections: null, variables: null }).ok).toBe(true);
  });
});

describe("template launch", () => {
  test("refusals are said in words, a pending launch keeps its meaning", () => {
    expect(templateFailure(409, "Template launch refused: variable_version_changed.")).toContain(
      "Publish a new revision",
    );
    for (const [reason, action] of [
      ["model_account_ambiguous", "Set a default in Start with > Harness"],
      ["model_account_refused", "Reconnect it in Start with > Harness"],
    ]) {
      const message = templateFailure(409, `Template launch refused: ${reason}.`);
      expect(message).toContain(action);
      expect(message).not.toContain("newer revision");
    }
    expect(templateFailure(409, "Template revision changed.")).toContain("newer revision");
    expect(templateFailure(409, "Request key already used with a different request.")).toContain(
      "still being confirmed",
    );
    expect(templateFailure(409, "Template name or request key already exists.")).toContain("name already exists");
    expect(templateFailure(403, "Template access denied.")).toContain("no longer have access");
    expect(templateFailure(403, "Template administrator permission required.")).toBe(
      "Only an admin changes organization templates.",
    );
  });

  test("lifetimes stay within the provider's limit", () => {
    expect(ttlOptions("modal").map((option) => option.value)).toEqual(["", "3600", "28800", "86400"]);
    expect(ttlOptions("boat").at(-1)?.value).toBe("604800");
    expect(ttlChoice("604800", "modal").ok).toBe(false);
    expect(ttlChoice("3600", "modal")).toEqual({ ok: true, value: 3600 });
    expect(ttlChoice("", "boat")).toEqual({ ok: true, value: undefined });
  });

  test("a launch target names the environment's projects, the tools and the first blocker", () => {
    const parsed = parseRevision(revision);
    const target = launchTarget(
      { ...(parseTemplate(header) as NonNullable<ReturnType<typeof parseTemplate>>), revision: parsed },
      [
        {
          id: SHARED,
          name: "shared",
          provider: "boat",
          config: { repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] },
          size_policy: null,
        },
      ],
      { ...lookups, variables: [] },
    );
    expect(target).toMatchObject({
      goldenName: "shared",
      repositories: ["web"],
      tools: ["Docs"],
      sizing: { policy: null },
      blocker: "APP_REGION was revoked or deleted.",
    });
  });

  test("the control client sends the pinned revision and key, and keeps no manifest", async () => {
    const calls: { route: string; body: Record<string, unknown> }[] = [];
    const control = createTemplateControl({
      serverUrl: "https://armada.test/mcp",
      token: "user-jwt",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ route: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
        return Response.json({ state: "succeeded", id: REGION, manifest: { variables: { APP_REGION: "eu" } } });
      }) as typeof fetch,
    });
    const outcome = await control.launch({ org: ORG, id: TEMPLATE, revision: 2, requestKey: "dashboard:k" });
    expect(outcome).toEqual({ state: "succeeded", id: REGION });
    expect(calls).toEqual([
      { route: "/api/v1/templates/launch", body: { org: ORG, id: TEMPLATE, revision: 2, requestKey: "dashboard:k" } },
    ]);
  });
});

test("template form binds metadata-only secrets, preserves aliases and refuses unreadable selections", () => {
  const secretId = "00000000-0000-4000-8000-000000000081";
  const sources = {
    ...lookups,
    secrets: [{ id: secretId, name: "APP_TOKEN", scope: "org" as const, version: 2, status: "active" }],
  };
  const previous = { ...definition, secrets: [{ key: "DEPLOY_TOKEN", secretId, version: 1 }] };
  const result = templateRequest(form({ secrets: [secretId] }), sources, previous);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.definition.secrets).toEqual([{ key: "DEPLOY_TOKEN", secretId, version: 2 }]);
  expect(templateRequest(form({ secrets: [secretId] }), { ...sources, secrets: null }, previous).ok).toBe(false);
  expect(parseRevision({ ...revision, definition: previous })?.definition.secrets).toEqual(previous.secrets);
});

test("secret references expose stale state and actionable closed refusals without values", () => {
  const secretId = "00000000-0000-4000-8000-000000000081";
  const def = { ...definition, secrets: [{ key: "APP_TOKEN", secretId, version: 1 }] };
  for (const secret of [
    { id: secretId, name: "APP_TOKEN", scope: "org" as const, version: 2, status: "active" },
    { id: secretId, name: "APP_TOKEN", scope: "org" as const, version: 1, status: "revoked" },
    {
      id: secretId,
      name: "APP_TOKEN",
      scope: "org" as const,
      version: 1,
      status: "active",
      expiresAt: "2000-01-01T00:00:00Z",
    },
  ]) {
    expect(templateState({ revision: { ...revision, definition: def } }, { ...lookups, secrets: [secret] }).label).toBe(
      "Secret changed",
    );
  }
  for (const reason of ["secret_unavailable", "secret_version_changed", "secret_delivery_unavailable"])
    expect(templateFailure(409, `Template launch refused: ${reason}.`)).not.toContain("could not be started");
});
