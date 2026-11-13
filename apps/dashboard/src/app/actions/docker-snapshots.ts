"use server";
import { HARNESSES, type Harness, parseDockerSnapshotRecord, parseGoldenConfig, validateSkillPins } from "@armada/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionResult, fail, formString, isUuid } from "@/lib/action";
import { CONNECTION_CHOICE_FIELD, launchSelection } from "@/lib/connections";
import { ControlError, controlPost } from "@/lib/control";
import { listSelectedConnections } from "@/lib/data/connections";
import { readDockerLaunchOption, readSelectedDockerHosts } from "@/lib/data/docker-hosts";
import { listSelectedAccounts } from "@/lib/data/model-accounts";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { launchedDockerSandbox, UNKNOWN_DOCKER_LAUNCH } from "@/lib/docker-launch";
import { mcpUrl } from "@/lib/env";
import { LAUNCH_PATH, LAUNCH_TIMEOUT_MS } from "@/lib/launch";
import { LAUNCH_KEY_FIELD } from "@/lib/launch-key";
import { checkAccountChoice } from "@/lib/model-accounts";
import { chosenConnection, modelChoice } from "@/lib/model-choice";
export type SnapshotCreateResult = { ok: true; message: string; snapshotId: string } | { ok: false; error: string };
const createFail = (error: string): SnapshotCreateResult => ({ ok: false, error });
export async function buildDockerSnapshot(
  _previous: SnapshotCreateResult | null,
  data: FormData,
): Promise<SnapshotCreateResult> {
  const selected = await selectedOrganization();
  if (!selected || formString(data, "org") !== selected.org.id) return createFail("Switch to that organization first.");
  const hostId = formString(data, "hostId"),
    requestId = formString(data, "requestId"),
    visibility = formString(data, "visibility");
  if (!isUuid(hostId) || !isUuid(requestId) || (visibility !== "private" && visibility !== "org"))
    return createFail("That snapshot request is not valid.");
  if (visibility === "org" && selected.role !== "admin")
    return createFail("Only an organization admin publishes shared snapshots.");
  const [hosts, option] = await Promise.all([readSelectedDockerHosts(), readDockerLaunchOption()]);
  if (
    hosts.state !== "ready" ||
    !hosts.list.placement ||
    !option?.capabilities.goldens ||
    !hosts.list.hosts.some((host) => host.id === hostId && host.state === "online")
  )
    return createFail("Choose an online host with snapshot support.");
  let config: ReturnType<typeof parseGoldenConfig>;
  try {
    config = parseGoldenConfig(JSON.parse(formString(data, "config")));
  } catch {
    return createFail("Choose a golden JSON file with repositories and init commands, without credentials.");
  }
  const viewer = await requireViewer(),
    serverUrl = mcpUrl();
  if (!viewer.token || !serverUrl) return createFail("The Armada server is not configured.");
  try {
    const row = parseDockerSnapshotRecord(
      (
        await controlPost(
          { serverUrl, token: viewer.token },
          "/api/v1/docker/snapshots/create",
          { org: selected.org.id, hostId, requestId, name: formString(data, "name"), visibility, config },
          "building a host snapshot",
        )
      ).snapshot,
    );
    revalidatePath("/environments");
    return { ok: true, message: "Snapshot build started.", snapshotId: row.id };
  } catch (error) {
    return createFail(
      error instanceof ControlError && error.outcomeUnknown
        ? "Build outcome unknown. Retry this unchanged form; do not start a second build."
        : error instanceof ControlError
          ? error.message
          : "Snapshot build could not be started.",
    );
  }
}
export async function launchFromDockerSnapshot(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const selected = await selectedOrganization(),
    org = formString(data, "org"),
    snapshotId = formString(data, "snapshotId"),
    requestId = formString(data, LAUNCH_KEY_FIELD),
    harness = formString(data, "harness") as Harness;
  if (!selected || org !== selected.org.id) return fail("Switch to that organization first.");
  if (!isUuid(snapshotId) || !isUuid(requestId) || !HARNESSES.includes(harness))
    return fail("That launch request is not valid.");
  if (formString(data, "armada_access")) return fail("Armada delegation is not supported for host snapshots yet.");
  const choice = modelChoice(harness, {
    model: formString(data, "model"),
    otherModel: formString(data, "other_model"),
    reasoningEffort: formString(data, "reasoning_effort"),
  });
  if (!choice.ok) return fail(choice.error);
  const fields = {
    model: formString(data, "model"),
    otherModel: formString(data, "other_model"),
    reasoningEffort: formString(data, "reasoning_effort"),
  };
  const picked = chosenConnection(fields);
  if (picked !== null && picked !== formString(data, "credential"))
    return fail("That model belongs to another account.");
  const account = checkAccountChoice(await listSelectedAccounts(), harness, formString(data, "credential"), Date.now());
  if (!account.ok) return fail(account.error);
  if (!account.id) return fail("Choose the account this agent runs on.");
  const skills = data.getAll("skills");
  try {
    validateSkillPins(skills);
  } catch {
    return fail("Choose exact skill pins.");
  }
  let connections: string[] | undefined;
  if (formString(data, CONNECTION_CHOICE_FIELD) === "explicit") {
    const requested = data.getAll("connections").map(String);
    if (!requested.length) connections = [];
    else {
      const current = await listSelectedConnections();
      if (current.state !== "ready") return fail("Connections are unavailable.");
      const result = launchSelection({ connections: requested, available: current.connections });
      if (!result.ok) return fail(result.error);
      connections = result.value.connections;
    }
  }
  const viewer = await requireViewer(),
    serverUrl = mcpUrl();
  if (!viewer.token || !serverUrl) return fail("The Armada server is not configured.");
  let id: string | null;
  try {
    id = launchedDockerSandbox(
      await controlPost(
        { serverUrl, token: viewer.token, timeoutMs: LAUNCH_TIMEOUT_MS },
        LAUNCH_PATH,
        {
          org,
          provider: "docker",
          snapshotId,
          requestId,
          harness,
          credentialId: account.id,
          model: choice.args.model,
          reasoningEffort: choice.args.reasoningEffort,
          ...(formString(data, "prompt").trim() ? { prompt: formString(data, "prompt").trim() } : {}),
          ...(skills.length ? { skills } : {}),
          ...(connections === undefined ? {} : { connections }),
        },
        "launching a host snapshot",
      ),
    );
  } catch (error) {
    return fail(
      error instanceof ControlError && (error.outcomeUnknown || error.code === "outcome_unknown")
        ? UNKNOWN_DOCKER_LAUNCH
        : error instanceof ControlError
          ? error.message
          : "Launch could not be confirmed.",
    );
  }
  if (!id) return fail(UNKNOWN_DOCKER_LAUNCH);
  revalidatePath("/sandboxes");
  redirect(`/sandboxes/${id}`);
}
