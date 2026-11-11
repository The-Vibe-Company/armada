import { type Harness, MODEL_CATALOG, PROVIDER_LIMITS, type SandboxProviderId } from "@armada/core";
import { EFFORT_LABEL, HARNESS_LABELS } from "./labels.ts";
import { type ModelFields, modelChoice } from "./model-choice.ts";
import type { Bucket, ResourceState } from "./resource-list.ts";

/**
 * The Templates page (#949, slice 6b of #906): launch presets as the control API's `templates/*` routes return them.
 * A template is a header (name, scope, current revision) and immutable numbered revisions, each freezing four
 * choices: an environment (a golden on one provider), tools (connection ids), the agent with its model and effort,
 * and readable variables (id and version). Secret bindings do not exist yet; nothing here sends or reads one.
 */
export type TemplateScope = "personal" | "org";

export type TemplateHeader = {
  id: string;
  orgId: string;
  ownerId: string;
  scope: TemplateScope;
  name: string;
  currentRevision: number;
  createdAt: string;
  updatedAt: string;
};

export type TemplateVariableBinding = { key: string; variableId: string; version: number };

export type TemplateDefinition = {
  goldenId: string;
  provider: SandboxProviderId;
  harness: Harness;
  model: string;
  reasoningEffort: string;
  connections: string[];
  variables: TemplateVariableBinding[];
  skills: string[];
  /** A pinned model account (set over the API); absent, each launch resolves the launcher's own. */
  modelAccount?: { id: string; version: number };
};

export type TemplateRevision = { id: string; revision: number; definition: TemplateDefinition };

/** A template with its current revision, or null when that revision could not be read. */
export type TemplateItem = TemplateHeader & { revision: TemplateRevision | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_TEMPLATE_NAME = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const iso = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

/** A list item or a mutation's `item`, kept only when well formed; a deleted template is not listed. */
export function parseTemplate(value: unknown): TemplateHeader | null {
  if (!isRecord(value)) return null;
  const { id, orgId, ownerId, scope, name, currentRevision, status } = value;
  const createdAt = iso(value.createdAt);
  const updatedAt = iso(value.updatedAt);
  if (
    !isId(id) ||
    !isId(orgId) ||
    !isId(ownerId) ||
    (scope !== "personal" && scope !== "org") ||
    typeof name !== "string" ||
    !name.trim() ||
    !isCount(currentRevision) ||
    status !== "active" ||
    !createdAt ||
    !updatedAt
  )
    return null;
  return { id, orgId, ownerId, scope, name: name.slice(0, MAX_TEMPLATE_NAME), currentRevision, createdAt, updatedAt };
}

/** A `get`'s `revision`: only the four choices are copied, never anything else the server might add. */
export function parseRevision(value: unknown): TemplateRevision | null {
  if (!isRecord(value) || !isId(value.id) || !isCount(value.revision) || !isRecord(value.definition)) return null;
  const d = value.definition;
  if (
    !isId(d.goldenId) ||
    (d.provider !== "boat" && d.provider !== "modal") ||
    (d.harness !== "claude" && d.harness !== "codex") ||
    typeof d.model !== "string" ||
    typeof d.reasoningEffort !== "string" ||
    !Array.isArray(d.connections) ||
    !d.connections.every(isId) ||
    !Array.isArray(d.variables)
  )
    return null;
  const variables: TemplateVariableBinding[] = [];
  for (const binding of d.variables) {
    if (!isRecord(binding) || typeof binding.key !== "string" || !isId(binding.variableId) || !isCount(binding.version))
      return null;
    variables.push({ key: binding.key, variableId: binding.variableId, version: binding.version });
  }
  const skills = Array.isArray(d.skills) ? d.skills.filter((skill): skill is string => typeof skill === "string") : [];
  const account = isRecord(d.modelAccount) ? d.modelAccount : null;
  const modelAccount =
    account && isId(account.id) && isCount(account.version) ? { id: account.id, version: account.version } : undefined;
  return {
    id: value.id,
    revision: value.revision,
    definition: {
      goldenId: d.goldenId,
      provider: d.provider,
      harness: d.harness,
      model: d.model,
      reasoningEffort: d.reasoningEffort,
      connections: [...d.connections],
      variables,
      skills,
      ...(modelAccount ? { modelAccount } : {}),
    },
  };
}

/** What a template refers to, as the viewer sees it now. A list that could not be read is null: nothing is judged. */
export type TemplateLookups = {
  goldens: readonly {
    id: string;
    name: string;
    provider: SandboxProviderId;
    visibility: "org" | "private";
    ready: boolean;
  }[];
  connections: readonly { id: string; name: string; scope: TemplateScope; status: string }[] | null;
  variables: readonly { id: string; name: string; scope: TemplateScope; version: number; status: string }[] | null;
};

export type TemplateProblem = { kind: "environment" | "tool" | "variable"; text: string };

/**
 * Why a launch from this revision would be refused, as far as the viewer can tell from what is listed. Only a fact
 * read from a list is a problem: a list that could not be read raises nothing (no false alarms).
 */
export function templateProblems(definition: TemplateDefinition, lookups: TemplateLookups): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  const golden = lookups.goldens.find((row) => row.id === definition.goldenId);
  if (!golden || golden.provider !== definition.provider)
    problems.push({ kind: "environment", text: "Its environment was removed or is no longer visible to you." });
  else if (!golden.ready) problems.push({ kind: "environment", text: `${golden.name} has no snapshot yet.` });
  if (lookups.connections)
    for (const id of definition.connections) {
      const tool = lookups.connections.find((row) => row.id === id);
      if (!tool) problems.push({ kind: "tool", text: "A tool was removed or is no longer visible to you." });
      else if (tool.status !== "connected")
        problems.push({ kind: "tool", text: `${tool.name} is not connected: reconnect it in Tools.` });
    }
  if (lookups.variables)
    for (const binding of definition.variables) {
      const variable = lookups.variables.find((row) => row.id === binding.variableId);
      if (variable?.status !== "active")
        problems.push({ kind: "variable", text: `${binding.key} was revoked or deleted.` });
      else if (variable.version !== binding.version)
        problems.push({
          kind: "variable",
          text: `${variable.name} changed since this revision: publish a new revision to use its new value.`,
        });
    }
  return problems;
}

/** A template's row state: ready to launch, or what needs the viewer first. */
export function templateState(
  item: Pick<TemplateItem, "revision">,
  lookups: TemplateLookups,
): ResourceState & { bucket: Bucket; problems: TemplateProblem[] } {
  if (!item.revision) return { bucket: "rest", tone: "neutral", label: "Details unavailable", problems: [] };
  const problems = templateProblems(item.revision.definition, lookups);
  if (problems.length === 0) return { bucket: "ready", tone: "success", label: "Ready", problems };
  const first = problems[0]?.kind;
  const label =
    first === "environment" ? "Environment unavailable" : first === "tool" ? "Tool not ready" : "Variable changed";
  return { bucket: "action", tone: "warning", label, problems };
}

/** The model's name as the catalog says it, or its id. */
export function modelLabel(harness: Harness, model: string): string {
  return MODEL_CATALOG[harness].models.find((option) => option.id === model)?.label ?? model;
}

/** "Claude Code · Opus 5.5 · High": the agent, model and effort of a revision. */
export function agentSummary(definition: Pick<TemplateDefinition, "harness" | "model" | "reasoningEffort">): string {
  return [
    HARNESS_LABELS[definition.harness],
    modelLabel(definition.harness, definition.model),
    EFFORT_LABEL[definition.reasoningEffort] ?? definition.reasoningEffort,
  ].join(" · ");
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Who can launch it: the row's fact. */
export function templateAudience(scope: TemplateScope, orgName: string): string {
  return scope === "personal" ? "Only you" : `Everyone in ${orgName}`;
}

/** Who may publish or delete it: its owner for a personal one, an admin for an org one (the server's rule). */
export function canManageTemplate(
  item: Pick<TemplateHeader, "scope" | "ownerId">,
  viewer: { userId: string; admin: boolean },
): boolean {
  return item.scope === "org" ? viewer.admin : item.ownerId === viewer.userId;
}

/** The create/edit form, as submitted. `variables` are variable ids; each binds under the variable's own name. */
export type TemplateFormFields = {
  name: string;
  scope: string;
  goldenId: string;
  harness: string;
  connections: readonly string[];
  variables: readonly string[];
} & ModelFields;

export type TemplateRequest = { name: string; scope: TemplateScope; definition: Record<string, unknown> };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The control API's `{name, scope, definition}` from the form, checked against what the viewer can see, so each
 * refusal is said in words before sending (the server's own is a generic "Invalid template request."). An org
 * template may only use org resources; the server checks every reference again.
 */
export function templateRequest(
  fields: TemplateFormFields,
  lookups: TemplateLookups,
  /** The revision a new one starts from: its unreadable selections block, its variable keys are kept. */
  previous?: Pick<TemplateDefinition, "connections" | "variables">,
): Parsed<TemplateRequest> {
  const lost = previous ? unreadableSelections(previous, lookups) : null;
  if (lost) return { ok: false, error: lost };
  const name = fields.name.trim();
  if (!name) return { ok: false, error: "Name the template." };
  if (name.length > MAX_TEMPLATE_NAME) return { ok: false, error: `Use at most ${MAX_TEMPLATE_NAME} characters.` };
  if (name.includes("\0")) return { ok: false, error: "The name cannot contain a NUL character." };
  if (fields.scope !== "personal" && fields.scope !== "org") return { ok: false, error: "Choose who can use it." };
  const scope = fields.scope;
  const golden = lookups.goldens.find((row) => row.id === fields.goldenId);
  if (!golden) return { ok: false, error: "Choose an environment." };
  if (!golden.ready) return { ok: false, error: `${golden.name} has no snapshot yet: snapshot it first.` };
  if (scope === "org" && golden.visibility !== "org")
    return { ok: false, error: `${golden.name} is private: an organization template needs a shared environment.` };
  const model = modelChoice(fields.harness, fields);
  if (!model.ok) return model;

  const connections = [...new Set(fields.connections)];
  if (connections.length > 0 && !lookups.connections)
    return { ok: false, error: "Tools could not be read. Refresh and try again." };
  for (const id of connections) {
    const tool = lookups.connections?.find((row) => row.id === id);
    if (!tool) return { ok: false, error: "A chosen tool is no longer available. Refresh and try again." };
    if (scope === "org" && tool.scope !== "org")
      return { ok: false, error: `${tool.name} is personal: an organization template uses organization tools only.` };
    if (tool.status !== "connected")
      return { ok: false, error: `${tool.name} is not connected. Reconnect it in Tools, or leave it out.` };
  }

  const ids = [...new Set(fields.variables)];
  if (ids.length > 0 && !lookups.variables)
    return { ok: false, error: "Variables could not be read. Refresh and try again." };
  if (ids.length > 64) return { ok: false, error: "A template takes at most 64 variables." };
  const variables: TemplateVariableBinding[] = [];
  for (const id of ids) {
    const variable = lookups.variables?.find((row) => row.id === id);
    if (variable?.status !== "active")
      return { ok: false, error: "A chosen variable is no longer available. Refresh and try again." };
    if (scope === "org" && variable.scope !== "org")
      return {
        ok: false,
        error: `${variable.name} is personal: an organization template uses organization variables only.`,
      };
    // A variable the revision already binds keeps its key, even when it differs from the variable's name.
    const key = previous?.variables.find((binding) => binding.variableId === id)?.key ?? variable.name;
    if (variables.some((binding) => binding.key === key))
      return { ok: false, error: `Two chosen variables would both be ${key}: keep one.` };
    variables.push({ key, variableId: variable.id, version: variable.version });
  }

  return {
    ok: true,
    value: {
      name,
      scope,
      definition: {
        goldenId: golden.id,
        provider: golden.provider,
        harness: model.args.harness,
        model: model.args.model,
        reasoningEffort: model.args.reasoningEffort,
        ...(connections.length ? { connections } : {}),
        ...(variables.length ? { variables } : {}),
      },
    },
  };
}

/**
 * Why a new revision cannot be published from this page now: a list it needs could not be read, so the tools or
 * variables the current revision uses would be dropped without the person seeing them. Null when nothing is lost.
 */
export function unreadableSelections(
  previous: Pick<TemplateDefinition, "connections" | "variables">,
  lookups: Pick<TemplateLookups, "connections" | "variables">,
): string | null {
  if (previous.connections.length > 0 && !lookups.connections)
    return "Tools could not be read, so this revision's tools would be lost. Refresh and try again.";
  if (previous.variables.length > 0 && !lookups.variables)
    return "Variables could not be read, so this revision's variables would be lost. Refresh and try again.";
  return null;
}

/** Why a launch was refused, in words, from the server's value-free reason code. */
const LAUNCH_REASONS: Record<string, string> = {
  environment_unavailable: "Its environment is no longer available, or has no snapshot.",
  environment_binding_changed: "Its environment moved to another Modal workspace. Publish a new revision.",
  environment_snapshot_unavailable: "Its environment's snapshot was retired. Rebuild the environment and try again.",
  environment_admission_unavailable: "Its environment changed while launching. Try again.",
  variable_unavailable: "A variable it uses was revoked or deleted. Publish a new revision without it.",
  variable_version_changed: "A variable it uses changed. Publish a new revision to use the new value.",
  variable_delivery_unavailable: "This provider cannot deliver variables yet.",
  connection_unavailable: "A tool it uses is not connected. Reconnect it in Tools, or publish a revision without it.",
  connection_version_changed: "A tool it uses was reconnected while launching. Try again.",
  model_account_unavailable: "No model account can run this agent. Add one in Harness.",
  model_account_version_changed: "Its model account changed. Try again.",
  model_account_incompatible: "Its model account cannot run this agent.",
  template_revision_changed: "A new revision was published while launching. Try again.",
  launch_unavailable: "The sandbox could not be started.",
};

export function launchReason(reason: string | null | undefined): string {
  return (reason && LAUNCH_REASONS[reason]) ?? "The sandbox could not be started.";
}

/**
 * A control API refusal in words. The template service's messages are deliberately generic, so the page says what
 * each one means here; a `Template launch refused: <reason>.` names its reason.
 */
export function templateFailure(status: number | undefined, message: string): string {
  const refused = /^Template launch refused: ([a-z_]+)\.$/.exec(message);
  if (refused) return launchReason(refused[1]);
  switch (status) {
    case 400:
      return "The server refused this template. Check the environment, tools and variables, then try again.";
    case 403:
      return message === "Template administrator permission required."
        ? "Only an admin changes organization templates."
        : "You no longer have access to templates in this organization. Refresh the page.";
    case 404:
      return "This template no longer exists. Refresh the page.";
    case 409:
      if (message === "Request key already used with a different request.")
        return "This launch is still being confirmed. Close the dialog and check Sandboxes before launching again.";
      if (message === "Template name or request key already exists.")
        return "A template with this name already exists for the same people. Choose another name.";
      return "Someone published a newer revision since this page loaded. Refresh and try again.";
    case 503:
      return "Templates are not available on this Armada server right now.";
    default:
      return message;
  }
}

/** What a `templates/launch` answered: the sandbox it started, a definite refusal, or an outcome not known yet. */
export type LaunchOutcome =
  | { state: "succeeded"; id: string }
  | { state: "failed"; reason: string }
  | { state: "reconciling"; id: string | null };

export function parseLaunchOutcome(value: unknown): LaunchOutcome | null {
  if (!isRecord(value)) return null;
  if (value.state === "succeeded" && isId(value.id)) return { state: "succeeded", id: value.id };
  if (value.state === "failed")
    return { state: "failed", reason: typeof value.reason === "string" ? value.reason : "" };
  // Claimed, allocating or reconciling: a sandbox may exist. Never reported as a failure that invites a new launch.
  if (typeof value.state === "string") return { state: "reconciling", id: isId(value.id) ? value.id : null };
  return null;
}

/** A launch's idempotency key: one per opening of the dialog, so a retry after a lost answer starts nothing new. */
export const REQUEST_KEY = /^dashboard:[0-9a-f-]{36}$/;
export const newRequestKey = () => `dashboard:${crypto.randomUUID()}`;

/** The lifetimes offered at launch, within the provider's limit. Empty: the server's default. */
export function ttlOptions(provider: SandboxProviderId): { value: string; label: string }[] {
  return [
    { value: "", label: "Default (4 hours)" },
    { value: "3600", label: "1 hour" },
    { value: "28800", label: "8 hours" },
    { value: "86400", label: "24 hours" },
    { value: "604800", label: "7 days" },
  ].filter((option) => !option.value || Number(option.value) <= PROVIDER_LIMITS[provider].maxTtlSeconds);
}

/** The launch form's lifetime, checked against the provider's limit; undefined is the server's default. */
export function ttlChoice(value: string, provider: SandboxProviderId): Parsed<number | undefined> {
  if (!value) return { ok: true, value: undefined };
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > PROVIDER_LIMITS[provider].maxTtlSeconds)
    return { ok: false, error: `Choose how long it runs, up to ${PROVIDER_LIMITS[provider].maxTtlLabel}.` };
  return { ok: true, value: seconds };
}
