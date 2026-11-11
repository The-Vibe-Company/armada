"use server";

import { MACHINE_SIZES, type MachineSize, type SandboxProviderId } from "@armada/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { ControlError } from "@/lib/control";
import { listGoldens } from "@/lib/data/goldens";
import { newWorkBlocker } from "@/lib/data/provider-setup";
import { selectedOrganization } from "@/lib/data/selected-org";
import { templateLookups, viewerTemplates } from "@/lib/data/templates";
import { PROVIDER_LABELS } from "@/lib/golden-form";
import { MACHINE_SIZE_LABELS } from "@/lib/machine-size";
import { goldenRepositoryDirs, repositoryChoice } from "@/lib/repository-context";
import { createClient } from "@/lib/supabase/server";
import {
  launchReason,
  REQUEST_KEY,
  type TemplateDefinition,
  templateFailure,
  templateRequest,
  ttlChoice,
} from "@/lib/templates";

/**
 * The Templates page's writes and launch (#949), each one control API call as the signed-in viewer. The server
 * checks every reference again; the page checks first so each refusal is said in words.
 */
type Templates = NonNullable<Awaited<ReturnType<typeof viewerTemplates>>>;
type Context = { templates: Templates; org: string; admin: boolean };

/** A launch whose outcome is not known: the dialog keeps its request key, so trying again starts nothing new. */
export type TemplateLaunchResult = ActionResult & { pending?: true };

async function scoped(data: FormData): Promise<Context | ActionResult> {
  const org = formString(data, "org");
  if (!isUuid(org)) return fail("That request is not valid.");
  const selected = await selectedOrganization();
  if (selected?.org.id !== org) return fail("Switch to that organization first.");
  const templates = await viewerTemplates();
  if (!templates) return fail("The Armada server is not configured for this dashboard.");
  return { templates, org, admin: selected.role === "admin" };
}

function target(data: FormData): { id: string; expectedRevision: number } | null {
  const id = formString(data, "id");
  const expectedRevision = Number(formString(data, "revision"));
  return isUuid(id) && Number.isSafeInteger(expectedRevision) && expectedRevision > 0 ? { id, expectedRevision } : null;
}

async function guarded(run: (context: Context) => Promise<ActionResult>, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if ("ok" in context) return context;
  try {
    const result = await run(context);
    revalidatePath("/templates");
    return result;
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    // A refusal without a code is the transport's (signed out, unreachable, an older server): its words are right.
    return fail(error.code ? templateFailure(error.status, error.message) : error.message);
  }
}

/** The form's choices against what the viewer can see now, with exact skills validated before publication. */
async function request(data: FormData, scope: string, previous?: TemplateDefinition) {
  return templateRequest(
    {
      name: formString(data, "name"),
      scope,
      goldenId: formString(data, "golden"),
      harness: formString(data, "harness"),
      model: formString(data, "model"),
      otherModel: formString(data, "other_model"),
      reasoningEffort: formString(data, "reasoning_effort"),
      connections: data.getAll("connections").map(String),
      variables: data.getAll("variables").map(String),
      skills: data.getAll("skills").map(String),
    },
    await templateLookups(),
    previous,
  );
}

export async function createTemplate(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  return guarded(async ({ templates, org, admin }) => {
    const scope = formString(data, "scope");
    if (scope === "org" && !admin) return fail("Only an admin creates organization templates.");
    const parsed = await request(data, scope);
    if (!parsed.ok) return fail(parsed.error);
    const { item } = await templates.create({ org, ...parsed.value });
    return done(`${item.name} is published (revision 1).`);
  }, data);
}

export async function publishTemplate(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  return guarded(async ({ templates, org }) => {
    const current = target(data);
    if (!current) return fail("That request is not valid.");
    // A publication replaces the whole definition: skills come from the picker initialized with this revision,
    // while retained variable bindings keep their keys. A pinned model account carries over only while the
    // person keeps it ticked; an account pinned for another agent cannot run the new one, so it goes with the agent
    // change.
    const { revision: previous } = await templates.get({ org, id: current.id, revision: current.expectedRevision });
    const kept = previous.definition;
    // The scope never changes: the revision is checked against the template's own.
    const parsed = await request(data, formString(data, "scope"), kept);
    if (!parsed.ok) return fail(parsed.error);
    const keepAccount =
      kept.modelAccount &&
      kept.harness === parsed.value.definition.harness &&
      formString(data, "keep_account") === "on";
    const definition = {
      ...parsed.value.definition,
      ...(keepAccount ? { modelAccount: kept.modelAccount } : {}),
    };
    let item: Awaited<ReturnType<Templates["publish"]>>["item"];
    try {
      ({ item } = await templates.publish({ org, ...current, definition }));
    } catch (error) {
      if (keepAccount && error instanceof ControlError && /: model_account_[a-z_]+\.$/.test(error.message))
        return fail(
          "Its pinned model account changed or was removed. Untick “Keep its pinned model account” to publish without it: each launch then uses the launcher's own account.",
        );
      throw error;
    }
    return done(`${item.name}: revision ${item.currentRevision} is published.`);
  }, data);
}

export async function deleteTemplate(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  return guarded(async ({ templates, org }) => {
    const current = target(data);
    if (!current) return fail("That request is not valid.");
    await templates.delete({ org, ...current });
    return done(`${formString(data, "name") || "The template"} is deleted.`);
  }, data);
}

/**
 * Launches the revision the person saw, with the four overrides a template allows (task, project, machine size,
 * lifetime). The dialog's request key makes a retry after a lost answer return the same launch, never a second one.
 */
export async function launchFromTemplate(
  _previous: TemplateLaunchResult | null,
  data: FormData,
): Promise<TemplateLaunchResult> {
  const context = await scoped(data);
  if ("ok" in context) return context;
  const { templates, org } = context;
  const id = formString(data, "id");
  const revision = Number(formString(data, "revision"));
  const requestKey = formString(data, "request_key");
  if (!isUuid(id) || !Number.isSafeInteger(revision) || revision < 1 || !REQUEST_KEY.test(requestKey))
    return fail("That request is not valid.");
  const size = formString(data, "size").trim();
  if (size && !(MACHINE_SIZES as readonly string[]).includes(size)) return fail("Choose a machine size from the list.");

  let outcome: Awaited<ReturnType<Templates["launch"]>>;
  let provider: SandboxProviderId;
  try {
    const { revision: saved } = await templates.get({ org, id, revision });
    provider = saved.definition.provider;
    const blocker = await newWorkBlocker(org, provider);
    if (blocker) return fail(blocker);
    const golden = (await listGoldens(await createClient())).find((row) => row.id === saved.definition.goldenId);
    if (!golden) return fail(launchReason("environment_unavailable"));
    const repository = repositoryChoice(formString(data, "repo"), goldenRepositoryDirs(golden.config));
    if (!repository.ok) return fail(repository.error);
    const ttl = ttlChoice(formString(data, "ttl"), provider);
    if (!ttl.ok) return fail(ttl.error);
    const prompt = formString(data, "prompt").trim();
    outcome = await templates.launch({
      org,
      id,
      revision,
      requestKey,
      ...(prompt ? { prompt } : {}),
      ...(ttl.value === undefined ? {} : { ttlSeconds: ttl.value }),
      ...(size ? { size } : {}),
      ...(repository.repo === undefined ? {} : { repo: repository.repo }),
    });
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    // No status: the request may have reached the server (a timeout, a dropped connection). Keep the key.
    // An unreadable success answer is not a refusal either: the sandbox may have started.
    if (
      error.status === undefined ||
      error.status < 300 ||
      error.status >= 500 ||
      error.message.startsWith("Request key")
    )
      return { ...fail(error.code ? templateFailure(error.status, error.message) : error.message), pending: true };
    return fail(error.code ? templateFailure(error.status, error.message) : error.message);
  }
  revalidatePath("/sandboxes");
  if (outcome.state === "succeeded") redirect(`/sandboxes/${outcome.id}`);
  if (outcome.state === "reconciling")
    return {
      ...fail(
        "Armada could not confirm whether the sandbox started. Check Sandboxes before launching again: launching again from this dialog repeats the same request and starts nothing new.",
      ),
      pending: true,
    };
  if (size && outcome.reason === "launch_unavailable")
    return fail(
      `${launchReason(outcome.reason)} If ${PROVIDER_LABELS[provider]} refused ${MACHINE_SIZE_LABELS[size as MachineSize]}, choose another size or the default.`,
    );
  return fail(launchReason(outcome.reason));
}
