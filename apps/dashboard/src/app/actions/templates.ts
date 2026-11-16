"use server";

import { MACHINE_SIZES, type MachineSize, type SandboxPlacementProviderId } from "@armada/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { ControlError } from "@/lib/control";
import { listGoldens } from "@/lib/data/goldens";
import { launchAccounts, listSelectedAccounts } from "@/lib/data/model-accounts";
import { newWorkBlocker } from "@/lib/data/provider-setup";
import { selectedOrganization } from "@/lib/data/selected-org";
import { templateLookups, viewerTemplates } from "@/lib/data/templates";
import { PROVIDER_LABELS } from "@/lib/golden-form";
import { followTemplateLaunch } from "@/lib/launch";
import { MACHINE_SIZE_LABELS } from "@/lib/machine-size";
import { goldenRepositoryDirs, repositoryChoice } from "@/lib/repository-context";
import { createClient } from "@/lib/supabase/server";
import { REQUEST_KEY, type TemplateDefinition, templateFailure, templateRequest, ttlChoice } from "@/lib/templates";

/**
 * The Templates page's writes and launch (#949), each one control API call as the signed-in viewer. The server
 * checks every reference again; the page checks first so each refusal is said in words.
 */
type Templates = NonNullable<Awaited<ReturnType<typeof viewerTemplates>>>;
type Context = { templates: Templates; org: string; admin: boolean };

/** A launch whose outcome is not known: the dialog keeps its request key, so trying again starts nothing new. */
export type TemplateLaunchResult = ActionResult & {
  pending?: true;
};

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
    return fail(templateFailure(error.status, error.message, error.code));
  }
}

/** The form's choices against what the viewer can see now, with exact skills validated before publication. */
async function request(data: FormData, scope: string, previous?: TemplateDefinition) {
  const credential = formString(data, "credential");
  const [lookups, accounts] = await Promise.all([
    templateLookups(),
    credential ? listSelectedAccounts() : Promise.resolve(null),
  ]);
  return templateRequest(
    {
      name: formString(data, "name"),
      scope,
      goldenId: formString(data, "golden"),
      placement: formString(data, "placement"),
      harness: formString(data, "harness"),
      model: formString(data, "model"),
      otherModel: formString(data, "other_model"),
      reasoningEffort: formString(data, "reasoning_effort"),
      connections: data.getAll("connections").map(String),
      variables: data.getAll("variables").map(String),
      skills: data.getAll("skills").map(String),
      secrets: data.getAll("secrets").map(String),
      credential,
    },
    { ...lookups, ...(accounts ? { accounts: launchAccounts(accounts, Date.now()) } : {}) },
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
    return done(`${item.name} is published (version 1).`);
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
    return done(`${item.name}: version ${item.currentRevision} is published.`);
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

  let outcome: Awaited<ReturnType<typeof followTemplateLaunch>>;
  let provider: SandboxPlacementProviderId | undefined;
  try {
    const { revision: saved } = await templates.get({ org, id, revision });
    provider = saved.definition.provider;
    const blocker = provider === "docker" ? null : await newWorkBlocker(org, provider);
    if (blocker) return fail(blocker);
    const golden = (await listGoldens(await createClient())).find((row) => row.id === saved.definition.goldenId);
    if (!golden && provider !== "docker") return fail("No such snapshot.");
    if (provider === "docker" && size) return fail("Docker templates use their host machine size.");
    const repository = repositoryChoice(formString(data, "repo"), golden ? goldenRepositoryDirs(golden.config) : []);
    if (!repository.ok) return fail(repository.error);
    const ttl = ttlChoice(formString(data, "ttl"), provider);
    if (!ttl.ok) return fail(ttl.error);
    const requestedAccount = formString(data, "model_account");
    let modelAccount: { id: string; version: number } | undefined;
    if (requestedAccount) {
      const [accountId, accountVersion, extra] = requestedAccount.split(":");
      const version = Number(accountVersion);
      if (
        saved.definition.modelAccount ||
        !accountId ||
        !isUuid(accountId) ||
        extra !== undefined ||
        !Number.isSafeInteger(version) ||
        version < 1
      )
        return fail("Choose an available model account.");
      modelAccount = { id: accountId, version };
    }
    const prompt = formString(data, "prompt").trim();
    outcome = await followTemplateLaunch({
      key: requestKey,
      exists: async (id) => {
        const client = await createClient();
        const { data, error } = await client
          .from("sandboxes")
          .select("id")
          .eq("id", id)
          .eq("org_id", org)
          .maybeSingle();
        if (error) throw new ControlError("Your sandbox could not be checked.");
        return !!data;
      },
      launch: () =>
        templates.launch({
          org,
          id,
          revision,
          requestKey,
          ...(modelAccount ? { modelAccount } : {}),
          ...(prompt ? { prompt } : {}),
          ...(ttl.value === undefined ? {} : { ttlSeconds: ttl.value }),
          ...(size ? { size } : {}),
          ...(repository.repo === undefined ? {} : { repo: repository.repo }),
        }),
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
      return {
        ...fail(
          `The launch could not be confirmed yet. Retry to check the same request; this will not start another sandbox.`,
        ),
        pending: true,
      };
    if (size && provider && error.code === "launch_unavailable")
      return fail(
        `${error.message} If ${PROVIDER_LABELS[provider]} refused ${MACHINE_SIZE_LABELS[size as MachineSize]}, choose another size or the default.`,
      );
    return fail(error.code ? error.message : templateFailure(error.status, error.message, error.code));
  }
  revalidatePath("/sandboxes");
  if (outcome.state === "started") redirect(`/sandboxes/${outcome.id}`);
  return {
    ...fail("The launch is still being confirmed. Retry to check the same request.", {
      href: "/sandboxes",
      label: "View sandboxes",
    }),
    pending: true,
  };
}
