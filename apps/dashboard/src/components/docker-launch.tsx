"use client";

import { type Harness, MODEL_CATALOG } from "@armada/core";
import { RocketIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { launchOnDockerHost } from "@/app/actions/docker-hosts";
import { ActionForm } from "@/components/action-form";
import { ComposerLocation, ComposerStop, DockerLimits, LaunchChip, LaunchComposer } from "@/components/launch-composer";
import { type LaunchConnections, LaunchStart, mcpFact, useLaunchAccess } from "@/components/launch-dialog";
import { LaunchAccountNotice, LaunchSentence } from "@/components/launch-sentence";
import { LaunchDialogContent } from "@/components/launch-surface";
import { SkillPicker } from "@/components/skill-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import type { ActionResult } from "@/lib/action";
import { CONNECTION_CHOICE_FIELD } from "@/lib/connections";
import { dockerLaunchKeyStorage, preferredHarness, UNKNOWN_DOCKER_LAUNCH } from "@/lib/docker-launch";
import { launchHoldIds } from "@/lib/launch-composer";
import { LAUNCH_KEY_FIELD, type LaunchKey, launchKeyFor } from "@/lib/launch-key";
import { initialLaunchSelection, type LaunchStartTarget } from "@/lib/launch-picker";
import { accountProblem, accountsFor, type LaunchAccounts } from "@/lib/model-accounts";

/**
 * Launch a sandbox on one Docker host (#1380): an agent the server runs on Docker, from Armada's image, which the person never chooses (#1507,
 * #1528), with a model account and an optional task. A Docker host has no environment (golden) yet, so this launch starts from the host, not from an
 * environment. What Docker cannot do yet is listed with the server's own reasons. A successful launch navigates to
 * the new sandbox.
 */
export function DockerLaunchDialog({
  orgId,
  hostId,
  hostName,
  accounts,
  unavailable,
  harnesses,
  initialHarness,
}: {
  orgId: string;
  hostId: string;
  hostName: string;
  accounts: LaunchAccounts;
  unavailable: { name: string; reason: string }[];
  /** The agents the server launches on Docker; at least one (the launch is blocked otherwise). */
  harnesses: Harness[];
  initialHarness: Harness;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" data-docker-launch={hostId}>
          <RocketIcon /> Launch on this host
        </Button>
      </DialogTrigger>
      <LaunchDialogContent>
        <LaunchStart
          orgId={orgId}
          hostId={hostId}
          hostName={hostName}
          accounts={accounts}
          unavailable={unavailable}
          harnesses={harnesses}
          initialHarness={initialHarness}
        />
      </LaunchDialogContent>
    </Dialog>
  );
}

export function DockerLaunchForm({
  connections,
  orgId,
  hostId,
  hostName,
  accounts,
  unavailable,
  harnesses,
  initialHarness,
  starts,
  selectedStart,
  onStart,
  idleDelaySeconds,
  task,
  onTask,
  launchBlockedReason,
  loadingError,
}: {
  connections: LaunchConnections;
  orgId: string;
  hostId: string;
  hostName: string;
  accounts: LaunchAccounts;
  unavailable: { name: string; reason: string }[];
  harnesses: Harness[];
  initialHarness: Harness;
  starts?: readonly LaunchStartTarget[];
  selectedStart?: string;
  onStart?: (id: string) => void;
  idleDelaySeconds?: number | undefined;
  launchBlockedReason?: string | undefined;
  loadingError?: string;
  task?: string;
  onTask?: (value: string) => void;
}) {
  const id = useId();
  const access = useLaunchAccess(connections);
  const [skills, setSkills] = useState<string[]>([]);
  const hasUsableAccount = (agent: Harness) =>
    accounts.state === "ready" &&
    accountsFor(accounts.accounts, agent).some((account) => accountProblem(account, accounts.now) === null);
  const [chosenHarness, setHarness] = useState<Harness>(() =>
    preferredHarness(harnesses, initialHarness, hasUsableAccount),
  );
  // A refresh can take the chosen agent off the server's list: the dialog then shows, and launches, an offered one.
  const harness = harnesses.includes(chosenHarness)
    ? chosenHarness
    : preferredHarness(harnesses, initialHarness, hasUsableAccount);
  const root = useRef<HTMLDivElement>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [localTask, setLocalTask] = useState("");
  const storage = dockerLaunchKeyStorage(hostId);
  const router = useRouter();
  const [credential, setCredential] = useState(
    () => initialLaunchSelection(accounts, MODEL_CATALOG, harness).credentialId,
  );
  const [blocked, setBlocked] = useState(false);
  const usable = hasUsableAccount(harness) && !blocked;

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    // A refused launch keeps what was typed, so the person fixes the cause and launches again.
    const keep = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    // The request key is the server's `requestId`. It is reused only after a launch with no definite answer, only
    // with the same choices and within KEY_TTL_MS, even if the dialog was closed in between: the server then
    // reconciles it instead of starting a second sandbox. A refusal makes the next launch a new request.
    const keyed = (event: Event) => {
      if (!(event instanceof FormDataEvent)) return;
      const key = launchKeyFor(readKey(storage), event.formData.entries());
      // Kept from now until a definite answer: a reload, a lost connection or a closed tab mid-launch keeps it too.
      writeKey(storage, key);
      event.formData.set(LAUNCH_KEY_FIELD, key.key);
    };
    node.addEventListener("reset", keep, true);
    node.addEventListener("formdata", keyed, true);
    return () => {
      node.removeEventListener("reset", keep, true);
      node.removeEventListener("formdata", keyed, true);
    };
  }, [storage]);

  const launch = useCallback(
    async (previous: ActionResult | null, data: FormData) => {
      // A thrown call (connection lost) is no answer: the stored key stays for the retry.
      const result = await launchOnDockerHost(previous, data);
      // A definite answer: the next launch is a new request.
      if (result.ok || result.error !== UNKNOWN_DOCKER_LAUNCH) writeKey(storage, null);
      if (result.ok && result.sandboxId) router.push(`/sandboxes/${result.sandboxId}`);
      return result;
    },
    [storage, router],
  );

  const holds = launchHoldIds(id, {
    source: Boolean(launchBlockedReason),
    account: !usable || accounts.state === "unavailable",
    tools: access.held,
  });
  return (
    <div ref={root}>
      <ActionForm
        action={launch}
        focusError
        renderContent={(result) => (
          <>
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="hostId" value={hostId} />
            <input type="hidden" name={CONNECTION_CHOICE_FIELD} value={access.explicit ? "explicit" : "defaults"} />
            <LaunchComposer
              id={id}
              headline={`What should we build on ${hostName}?`}
              subline="Environment: Armada official (fetched by your host the first time)"
              loadingError={loadingError}
              docker
              dockerHost
              task={task ?? localTask}
              onTask={onTask ?? setLocalTask}
              holds={holds}
              tools={
                <LaunchChip
                  title="Tools"
                  label={`Tools · ${mcpFact(access)}`}
                  warning={access.held || access.unavailable}
                >
                  {access.fields(id)}
                </LaunchChip>
              }
              skills={
                <LaunchChip title="Skills" label={`Skills · ${skills.length}`}>
                  <SkillPicker inline orgId={orgId} value={skills} onChange={setSkills} />
                </LaunchChip>
              }
              agent={
                <LaunchSentence
                  harness={harness}
                  onHarness={setHarness}
                  account={credential}
                  onAccount={setCredential}
                  onBlocked={setBlocked}
                  accounts={accounts}
                  catalog={MODEL_CATALOG}
                  boatOpenCodeDisabled={false}
                  allowedHarnesses={harnesses}
                  open={modelOpen}
                  onOpenChange={setModelOpen}
                />
              }
              alerts={
                <>
                  {launchBlockedReason && (
                    <p id={`${id}-source-blocked`} role="alert" tabIndex={-1} className="text-sm text-warning">
                      {launchBlockedReason}
                    </p>
                  )}
                  <LaunchAccountNotice
                    idPrefix={id}
                    harness={harness}
                    account={credential}
                    accounts={accounts}
                    onPick={() => setModelOpen(true)}
                  />
                  {access.alerts(() => {}, id)}
                  {result}
                </>
              }
              location={
                <ComposerLocation
                  name={hostName}
                  starts={starts}
                  selectedStart={selectedStart}
                  onStart={onStart}
                  folder={false}
                  repositories={[]}
                  project=""
                  onProject={() => {}}
                />
              }
              options={
                <>
                  <ComposerStop provider="docker" idleDelaySeconds={idleDelaySeconds} />
                  <DockerLimits unavailable={unavailable} />
                </>
              }
            />
            {skills.map((exact) => (
              <input key={exact} type="hidden" name="skills" value={exact} />
            ))}
            {access.inputs}
          </>
        )}
      />
    </div>
  );
}

/** Longer than a launch's own deadline; after it, the same choices start a new sandbox. */
const KEY_TTL_MS = 15 * 60_000;

function readKey(name: string): LaunchKey | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(name) ?? "null");
    if (
      typeof value === "object" &&
      value !== null &&
      "key" in value &&
      "fingerprint" in value &&
      "at" in value &&
      typeof value.key === "string" &&
      typeof value.fingerprint === "string" &&
      typeof value.at === "number" &&
      Date.now() - value.at < KEY_TTL_MS
    )
      return { key: value.key, fingerprint: value.fingerprint };
  } catch {
    // Storage refused or unreadable: the launch is a new request.
  }
  return null;
}

function writeKey(name: string, key: LaunchKey | null): void {
  try {
    if (key) sessionStorage.setItem(name, JSON.stringify({ ...key, at: Date.now() }));
    else sessionStorage.removeItem(name);
  } catch {
    // Storage refused: a later retry is a new request, as without this dialog's memory.
  }
}
