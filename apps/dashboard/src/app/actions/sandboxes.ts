"use server";

import { type Harness, MODEL_CATALOG, validateSkillPins } from "@armada/core";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import {
  chosenConversation,
  drivingFailureMessage,
  INCOMPLETE_MODEL,
  modelChange,
  pinnedSend,
  SEND_KEY_FIELD,
  STEER_KEEPS_MODEL,
} from "@/lib/composer";
import { CONNECTION_CHOICE_FIELD, launchSelection } from "@/lib/connections";
import { ControlError } from "@/lib/control";
import { listSelectedConnections } from "@/lib/data/connections";
import { readDockerLaunchOption, readSelectedDockerHosts } from "@/lib/data/docker-hosts";
import { readSelectedDockerSnapshots } from "@/lib/data/docker-snapshots";
import { viewerGateway } from "@/lib/data/gateway";
import { listGoldens } from "@/lib/data/goldens";
import { readLaunchOptions } from "@/lib/data/launch-options";
import { launchAccounts, listSelectedAccounts } from "@/lib/data/model-accounts";
import { newWorkBlocker, readProviderSetup } from "@/lib/data/provider-setup";
import { getSandbox } from "@/lib/data/sandboxes";
import { isSelectedOrganization, selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { dockerHarnesses, dockerLaunchBlocker } from "@/lib/docker-launch";
import { snapshotLaunchEnabled } from "@/lib/docker-snapshots";
import { mcpUrl } from "@/lib/env";
import { createGateway, GatewayError } from "@/lib/gateway";
import { goldenLaunchReadiness, PROVIDER_LABELS } from "@/lib/golden-form";
import { DOCKER_HOST_LABEL, dockerHostGroup } from "@/lib/labels";
import {
  decodeLaunchAttempt,
  encodeLaunchAttempt,
  type FollowedLaunch,
  followLaunch,
  launchAttemptCookie,
  launchFailureMessage,
  launchSandbox,
} from "@/lib/launch";
import { LAUNCH_KEY_FIELD } from "@/lib/launch-key";
import { boatOpenCodeAvailable } from "@/lib/launch-options";
import type { LaunchStartTarget } from "@/lib/launch-picker";
import { goldenSizing, MACHINE_SIZE_LABELS, PROVIDER_REFUSALS, policyHasDefaults } from "@/lib/machine-size";
import { checkAccountChoice } from "@/lib/model-accounts";
import { chosenConnection, launchArgs, type ModelFields, type SendArgs, sendOverride } from "@/lib/model-choice";
import { connectedProviders } from "@/lib/provider-setup";
import { goldenRepositoryDirs, repositoryChoice } from "@/lib/repository-context";
import { filtersToSearch } from "@/lib/sandbox-filters";
import { lifecycleFailure } from "@/lib/sandbox-lifecycle";
import { createClient } from "@/lib/supabase/server";
import { ttlChoice } from "@/lib/templates";

async function gatewayFor(id: string) {
  const viewer = await requireViewer();
  const gateway = viewerGateway(viewer);
  if (!gateway) return { error: fail("The Armada server is not configured for this dashboard.") };
  const supabase = await createClient();
  const sandbox = await getSandbox(supabase, id);
  if (!sandbox) return { error: fail("That sandbox does not exist, or it is not yours to see.") };
  return { gateway, sandbox, owner: sandbox.owner_id === viewer.id };
}

/**
 * A refused send, steer or interrupt in words. An unbound legacy Modal sandbox (`credential_binding_required`) is
 * recovered on this page, not with the CLI command the server's own message names.
 */
function drivingFailure(error: GatewayError, owner: boolean, keyedSend = false): ActionResult {
  return fail(drivingFailureMessage(error, owner, keyedSend));
}

/** Run a shell command through the existing user-authorized, redacting MCP tool. */
export async function execSandbox(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const id = formString(data, "sandbox");
  const command = formString(data, "command").trim();
  if (!isUuid(id) || !command) return fail("Enter a command.");
  const target = await gatewayFor(id);
  if (target.error) return target.error;
  const viewer = await requireViewer();
  const url = mcpUrl();
  if (!url || !viewer.token) return fail("The Armada server is not configured.");
  try {
    const result = await createGateway({ url, token: viewer.token }).call("exec", { id, command, timeout_seconds: 30 });
    if (!result || typeof result !== "object")
      return fail("The command result was not available. Check before retrying.");
    const output = result as Record<string, unknown>;
    const text = [output.stdout, output.stderr]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    return done(
      `${text}\n${output.timedOut ? "Timed out" : `Exit ${output.exitCode ?? "unknown"}`}${output.truncated ? " · Output truncated" : ""}`,
    );
  } catch (error) {
    if (error instanceof GatewayError) return fail(error.message);
    throw error;
  }
}

/** Set a later deadline through the existing owner/admin-authorized server action. */
export async function extendSandbox(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const id = formString(data, "sandbox");
  if (!isUuid(id)) return fail("That request is not valid.");
  const target = await gatewayFor(id);
  if (target.error) return target.error;
  if (target.sandbox.provider === "docker") return fail("The time limit cannot be extended on a Docker host.");
  const expires = Date.parse(target.sandbox.expires_at ?? "");
  if (!Number.isFinite(expires)) return fail("This sandbox has no recorded deadline to extend.");
  const viewer = await requireViewer();
  const url = mcpUrl();
  if (!url || !viewer.token) return fail("The Armada server is not configured.");
  const ttl = Math.ceil((Math.max(Date.now(), expires) - Date.now()) / 1000) + 3600;
  try {
    await createGateway({ url, token: viewer.token }).call("extend", { id, ttl_seconds: ttl });
  } catch (error) {
    if (error instanceof GatewayError) return fail(error.message);
    throw error;
  }
  revalidatePath(`/sandboxes/${id}`);
  revalidatePath("/sandboxes");
  return done("Added one hour to the deadline.");
}

export async function stopSandbox(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const id = formString(data, "sandbox");
  if (!isUuid(id)) return fail("That request is not valid.");
  const target = await gatewayFor(id);
  if (target.error) return target.error;
  try {
    await target.gateway.stop(id);
  } catch (error) {
    if (error instanceof GatewayError) return fail(lifecycleFailure("stop", error));
    throw error;
  }
  revalidatePath(`/sandboxes/${id}`);
  revalidatePath("/sandboxes");
  return done(
    target.sandbox.provider === "docker"
      ? "Stop requested. The container stops and its workspace stays on the host."
      : "Stop requested. The machine is removed and the disk is kept.",
  );
}

/**
 * Deletes a stopped or failed sandbox. The dashboard offers it on Docker sandboxes, where the server reports delete
 * as supported (#1380); the server checks the owner/admin role, the status and the capability again.
 */
export async function deleteSandbox(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const id = formString(data, "sandbox");
  if (!isUuid(id)) return fail("That request is not valid.");
  const target = await gatewayFor(id);
  if (target.error) return target.error;
  if (target.sandbox.provider !== "docker") return fail("Deleting is offered for Docker sandboxes only.");
  if (target.sandbox.status !== "stopped" && target.sandbox.status !== "failed")
    return fail("Stop the sandbox before deleting it.");
  try {
    await target.gateway.delete(id);
  } catch (error) {
    if (error instanceof GatewayError) return fail(lifecycleFailure("delete", error));
    throw error;
  }
  revalidatePath("/sandboxes");
  redirect("/sandboxes");
}

/** A new turn, in the conversation the person chose. The model and effort override applies to this turn only. */
export async function sendToSandbox(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const id = formString(data, "sandbox");
  const prompt = formString(data, "prompt").trim();
  if (!isUuid(id)) return fail("That request is not valid.");
  if (!prompt) return fail("Write the message to send.");
  if (modelChange(modelFields(data)) === "incomplete") return fail(INCOMPLETE_MODEL);
  const target = await gatewayFor(id);
  if (target.error) return target.error;
  const conversation = chosenConversation(formString(data, "conversation"), target.sandbox.conversation_ids);
  if (!conversation.ok) return fail(conversation.error);
  let override: SendArgs = {};
  const requestId = formString(data, SEND_KEY_FIELD);
  if (!isUuid(requestId)) return fail("That request is not valid. Reload the page and send it again.");
  const pinned =
    target.sandbox.provider === "docker" ||
    target.sandbox.boat_runtime ||
    target.sandbox.runtime_transport === "dialout";
  if (pinned) {
    // Runtime-backed sandboxes keep launch choices and admit stable instruction IDs.
    const checked = pinnedSend(modelFields(data), requestId);
    if (!checked.ok) return fail(checked.error);
  } else {
    const chosen = sendOverride(target.sandbox.harness, modelFields(data), target.sandbox.model);
    if (!chosen.ok) return fail(chosen.error);
    override = chosen.args;
  }
  try {
    await target.gateway.send(id, prompt, override, conversation.id, requestId);
  } catch (error) {
    if (error instanceof GatewayError) return drivingFailure(error, target.owner, pinned);
    throw error;
  }
  revalidatePath(`/sandboxes/${id}`);
  revalidatePath("/sandboxes");
  return done("Sent.");
}

/** A message into the turn running in the chosen conversation. It never changes the model: that is a new turn. */
export async function steerSandbox(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const id = formString(data, "sandbox");
  const text = formString(data, "prompt").trim();
  if (!isUuid(id)) return fail("That request is not valid.");
  if (!text) return fail("Write the message to send.");
  if (modelChange(modelFields(data)) !== "none") return fail(STEER_KEEPS_MODEL);
  const target = await gatewayFor(id);
  if (target.error) return target.error;
  const conversation = chosenConversation(formString(data, "conversation"), target.sandbox.conversation_ids);
  if (!conversation.ok) return fail(conversation.error);
  let receipt: unknown;
  try {
    receipt = await target.gateway.steer(id, text, conversation.id);
  } catch (error) {
    if (error instanceof GatewayError) return drivingFailure(error, target.owner);
    throw error;
  }
  revalidatePath(`/sandboxes/${id}`);
  const restarted =
    typeof receipt === "object" && receipt !== null && "delivery" in receipt && receipt.delivery === "restart";
  return done(restarted ? "Steered. The turn restarted with your message." : "Steered.");
}

/** Stops the turn running in the chosen conversation. The sandbox stays up for the next message. */
export async function interruptSandbox(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const id = formString(data, "sandbox");
  if (!isUuid(id)) return fail("That request is not valid.");
  const target = await gatewayFor(id);
  if (target.error) return target.error;
  const conversation = chosenConversation(formString(data, "conversation"), target.sandbox.conversation_ids);
  if (!conversation.ok) return fail(conversation.error);
  try {
    await target.gateway.interrupt(id, conversation.id);
  } catch (error) {
    if (error instanceof GatewayError) return drivingFailure(error, target.owner);
    throw error;
  }
  revalidatePath(`/sandboxes/${id}`);
  return done("Interrupt requested.");
}

export async function launchFromGolden(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  if (
    data.getAll("armada_access").length > 1 ||
    (data.get("armada_access") !== null && data.get("armada_access") !== "on")
  )
    return fail("That request is not valid.");
  // Never trust a posted availability field; reauthorize normal runtime support on this request.
  const discovery =
    formString(data, "provider") === "boat" && formString(data, "harness") === "opencode"
      ? await readLaunchOptions()
      : undefined;
  const parsed = launchArgs(
    {
      golden: formString(data, "golden"),
      provider: formString(data, "provider"),
      org: formString(data, "org"),
      harness: formString(data, "harness"),
      prompt: formString(data, "prompt"),
      repo: formString(data, "repo"),
      size: formString(data, "size"),
      armadaAccess: formString(data, "armada_access"),
      ...modelFields(data),
    },
    discovery,
  );
  if (!parsed.ok) return fail(parsed.error);
  const ttl = ttlChoice(formString(data, "ttl"), parsed.args.provider);
  if (!ttl.ok) return fail(ttl.error);
  if (!isUuid(parsed.args.org)) return fail("That request is not valid.");
  // A connection model is billed to its own connection: never run it on another account.
  const connection = chosenConnection(modelFields(data));
  if (connection !== null && connection !== formString(data, "credential"))
    return fail("That model belongs to another connection. Choose the model again.");
  if (!(await isSelectedOrganization(parsed.args.org))) return fail("Switch to that organization first.");
  const blocker = await newWorkBlocker(parsed.args.org, parsed.args.provider);
  if (blocker) return fail(blocker);
  const skills = data.getAll("skills");
  try {
    validateSkillPins(skills);
  } catch {
    return fail("Choose at most 20 distinct skills pinned to exact versions. Armada tools are managed automatically.");
  }
  const viewer = await requireViewer();
  const serverUrl = mcpUrl();
  const token = viewer.token;
  if (!serverUrl || !token) return fail("The Armada server is not configured for this dashboard.");

  const supabase = await createClient();
  const matches = (await listGoldens(supabase)).filter(
    (golden) =>
      golden.name === parsed.args.golden &&
      golden.provider === parsed.args.provider &&
      golden.org_id === parsed.args.org,
  );
  if (matches.length === 0) return fail("That snapshot is not available in this organization.");
  // Who may open the sandbox is its owner and the org's admins (#680); the launch no longer chooses a visibility.
  // Connections go only when the person chose them; otherwise the server applies and checks the defaults (#681).
  let connections: string[] | undefined;
  const requested = data.getAll("connections").map(String);
  // A deliberate empty selection needs no candidates, so it does not depend on the registry list.
  if (data.get(CONNECTION_CHOICE_FIELD) === "explicit" && requested.length === 0) connections = [];
  else if (data.get(CONNECTION_CHOICE_FIELD) === "explicit") {
    const listed = await listSelectedConnections();
    if (listed.state !== "ready") {
      return fail(listed.state === "error" ? listed.message : "Connections are not available right now.");
    }
    const selection = launchSelection({
      connections: requested,
      available: listed.connections,
    });
    if (!selection.ok) return fail(selection.error);
    connections = selection.value.connections;
  }
  const repository = repositoryChoice(
    formString(data, "repo"),
    matches.flatMap((golden) => goldenRepositoryDirs(golden.config)),
  );
  if (!repository.ok) return fail(repository.error);
  const account = await accountChoice(parsed.args.harness, formString(data, "credential"));
  if (!account.ok) return fail(account.error);
  if (parsed.args.armadaAccess && !account.id) return fail("Armada access requires an explicit named Codex account.");

  const jar = await cookies();
  const key = formString(data, LAUNCH_KEY_FIELD);
  const cookie = isUuid(key) ? launchAttemptCookie(key) : "";
  let launched: FollowedLaunch;
  try {
    launched = await followLaunch({
      key,
      previous: cookie ? decodeLaunchAttempt(jar.get(cookie)?.value) : null,
      now: Date.now,
      remember: (attempt) => {
        jar.set(cookie, encodeLaunchAttempt(attempt), {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          path: "/",
          maxAge: 3_600,
        });
      },
      forget: () => {
        jar.delete(cookie);
      },
      // The viewer's own live sandboxes from the chosen golden and agent since the first attempt: what this
      // submission created. A failed or removed one is not followed: launching again is then the right retry.
      created: async (since) => {
        const { data: rows, error } = await supabase
          .from("sandboxes")
          .select("id")
          .eq("owner_id", viewer.id)
          .eq("org_id", parsed.args.org)
          .eq("harness", parsed.args.harness)
          .in(
            "golden_id",
            matches.map((golden) => golden.id),
          )
          .not("status", "in", "(failed,deleted)")
          // A few seconds of slack for the dashboard and database clocks.
          .gte("created_at", new Date(since - 5_000).toISOString())
          .order("created_at", { ascending: false })
          .limit(1);
        if (error) throw new ControlError("Your sandboxes could not be checked. Open them before launching again.");
        return rows?.[0]?.id ?? null;
      },
      launch: () =>
        launchSandbox(
          { serverUrl, token },
          {
            ...parsed.args,
            ...(ttl.value === undefined ? {} : { ttlSeconds: ttl.value }),
            ...(skills.length ? { skills } : {}),
            ...(connections === undefined ? {} : { connections }),
            ...(repository.repo === undefined ? {} : { repo: repository.repo }),
            ...(account.id === undefined ? {} : { credentialId: account.id }),
            // Stored defaults are a promise only the versioned sized route keeps; without any, legacy is the same launch.
            ...(matches.some((golden) => policyHasDefaults(golden.size_policy)) ? { sizePolicy: true } : {}),
          },
        ),
    });
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    // A provider refusing an explicit size (plan, disk) is never retried with another: say what can be changed.
    if (parsed.args.size && error.code && PROVIDER_REFUSALS.has(error.code))
      return fail(
        `${launchFailureMessage(error)} If ${PROVIDER_LABELS[parsed.args.provider]} refused ${MACHINE_SIZE_LABELS[parsed.args.size]}, choose another size or the default.`,
      );
    return fail(launchFailureMessage(error));
  }
  if (launched.state === "unknown") {
    const search = filtersToSearch({
      owner: ["me"],
      provider: [parsed.args.provider],
      harness: [parsed.args.harness],
      sort: "newest",
    });
    return fail(
      "The Armada server did not confirm the launch and no sandbox from it is listed yet. It may still be starting: check your sandboxes before launching again.",
      { href: `/sandboxes${search}`, label: "Your newest sandboxes" },
    );
  }
  // The launch is known: its attempt is not followed again, and the cookie stops travelling with every request.
  if (cookie) jar.delete(cookie);
  revalidatePath("/sandboxes");
  redirect(`/sandboxes/${launched.id}`);
}

function modelFields(data: FormData): ModelFields {
  return {
    model: formString(data, "model"),
    otherModel: formString(data, "other_model"),
    reasoningEffort: formString(data, "reasoning_effort"),
  };
}

/**
 * The model account a launch bills, checked against what the viewer may use now. With compatible accounts listed
 * the person must have chosen one; it is sent as an explicit id, never left for the server to pick. A server older
 * than named accounts gets none and resolves its own. Accounts that cannot be read block the launch.
 */
async function accountChoice(
  harness: Harness,
  requested: string,
): Promise<{ ok: true; id: string | undefined } | { ok: false; error: string }> {
  if (requested && !isUuid(requested)) return { ok: false, error: "That request is not valid." };
  return checkAccountChoice(await listSelectedAccounts(), harness, requested, Date.now());
}

/** Read the selected organization's visible launch sources only, using the viewer's JWT. */
export async function readLaunchDialogOptions() {
  const selected = await selectedOrganization();
  if (!selected) throw new Error("Choose an organization first.");
  const supabase = await createClient();
  const [goldens, hostRead, snapshotRead, dockerOption, discovery, listed, accountList, setup, idleDelaySeconds] =
    await Promise.all([
      listGoldens(supabase),
      readSelectedDockerHosts(),
      readSelectedDockerSnapshots(),
      readDockerLaunchOption(),
      readLaunchOptions(),
      listSelectedConnections(),
      listSelectedAccounts(),
      readProviderSetup(selected.org.id),
      readLaunchIdleDelay(),
    ]);
  const connected = setup.state === "unavailable" ? null : connectedProviders(setup.status);
  const targets: LaunchStartTarget[] = goldens.flatMap((golden): LaunchStartTarget[] => {
    if (golden.provider === "docker") return [];
    const repositories = goldenRepositoryDirs(golden.config);
    const sizing = goldenSizing(golden, repositories);
    const readiness = goldenLaunchReadiness({
      provider: golden.provider,
      hasSnapshot: Boolean(golden.provider_snapshot_id),
      serverReady: Boolean(mcpUrl()),
      connected,
    });
    return [
      {
        id: golden.id,
        golden: golden.name,
        provider: golden.provider,
        label: `${golden.name} · ${golden.provider === "boat" ? "Boat" : "Modal"} cloud`,
        group: `${golden.provider === "boat" ? "Boat" : "Modal"} cloud`,
        repositories,
        ...(readiness.kind === "ready" ? {} : { reason: readiness.detail }),
        ...(sizing.kind === "ready" ? { sizing: { policy: sizing.policy } } : {}),
        ...(sizing.kind === "unreadable" ? { reason: sizing.reason } : {}),
      },
    ];
  });
  const agents = dockerHarnesses(dockerOption);
  if (hostRead.state === "ready") {
    for (const host of hostRead.list.hosts.filter((host) => host.state !== "revoked")) {
      const reason = dockerLaunchBlocker(dockerOption, hostRead.list.placement, host);
      targets.push({
        id: host.id,
        golden: "",
        provider: "docker",
        hostId: host.id,
        label: `Empty machine · ${host.name ?? DOCKER_HOST_LABEL}`,
        group: dockerHostGroup(host.name, host.state),
        hostName: host.name ?? DOCKER_HOST_LABEL,
        repositories: [],
        harnesses: agents.offered,
        ...(agents.initial ? { initialHarness: agents.initial } : {}),
        ...(reason ? { reason } : {}),
      });
      if (snapshotRead.state === "ready") {
        for (const snapshot of snapshotRead.snapshots.filter((snapshot) => snapshot.hostId === host.id)) {
          const blocked =
            reason ??
            (snapshot.status !== "ready"
              ? "Not built yet. Open Snapshots to build it."
              : !snapshot.hostAvailable
                ? "This Docker host is unavailable."
                : !snapshotLaunchEnabled(dockerOption, hostRead.list.placement)
                  ? "This Docker host does not support snapshot launches."
                  : null);
          targets.push({
            id: snapshot.id,
            golden: snapshot.name,
            provider: "docker",
            snapshotId: snapshot.id,
            label: `${snapshot.name} · ${host.name ?? DOCKER_HOST_LABEL}`,
            group: dockerHostGroup(host.name, host.state),
            hostName: host.name ?? DOCKER_HOST_LABEL,
            repositories: [],
            harnesses: agents.offered,
            ...(blocked ? { reason: blocked } : {}),
          });
        }
      }
    }
  }
  return {
    orgId: selected.org.id,
    targets,
    catalog: MODEL_CATALOG,
    accounts: launchAccounts(accountList, Date.now()),
    connections:
      listed.state === "ready" ? { connections: listed.connections } : { unavailable: "Tools could not be loaded." },
    boatOpenCodeAvailable: boatOpenCodeAvailable(discovery),
    ...(idleDelaySeconds === undefined ? {} : { idleDelaySeconds }),
  };
}

/** The server publishes its resolved idle policy in healthz; never substitute a dashboard default. */
async function readLaunchIdleDelay(): Promise<number | undefined> {
  const serverUrl = mcpUrl();
  if (!serverUrl) return undefined;
  try {
    const response = await fetch(new URL("/healthz", serverUrl), {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("idlePauseDelayMs" in body)) return undefined;
    const delay = body.idlePauseDelayMs;
    return typeof delay === "number" && Number.isSafeInteger(delay) && delay > 0 ? delay / 1_000 : undefined;
  } catch {
    return undefined;
  }
}
