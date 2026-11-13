"use client";

import { type Harness, MODEL_CATALOG } from "@armada/core";
import { RocketIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { launchOnDockerHost } from "@/app/actions/docker-hosts";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AccountField, Segmented } from "@/components/launch-dialog";
import {
  LaunchAdvanced,
  LaunchDialogContent,
  LaunchDialogHeader,
  LaunchFields,
  LaunchTaskField,
  useLaunchSurface,
} from "@/components/launch-surface";
import { SubmitShortcut } from "@/components/mod-key";
import { ModelFields } from "@/components/model-fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import type { ActionResult } from "@/lib/action";
import { dockerLaunchKeyStorage, preferredHarness, UNKNOWN_DOCKER_LAUNCH } from "@/lib/docker-launch";
import { HARNESS_LABELS } from "@/lib/labels";
import { LAUNCH_KEY_FIELD, type LaunchKey, launchKeyFor } from "@/lib/launch-key";
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
        <LaunchDialogHeader
          title={`Launch on ${hostName}`}
          description="An agent in a private sandbox, using the official Armada environment on this host."
        />
        <DockerLaunchForm
          orgId={orgId}
          hostId={hostId}
          accounts={accounts}
          unavailable={unavailable}
          harnesses={harnesses}
          initialHarness={initialHarness}
        />
      </LaunchDialogContent>
    </Dialog>
  );
}

function DockerLaunchForm({
  orgId,
  hostId,
  accounts,
  unavailable,
  harnesses,
  initialHarness,
}: {
  orgId: string;
  hostId: string;
  accounts: LaunchAccounts;
  unavailable: { name: string; reason: string }[];
  harnesses: Harness[];
  initialHarness: Harness;
}) {
  const id = useId();
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
  useLaunchSurface(root);
  const storage = dockerLaunchKeyStorage(hostId);
  const router = useRouter();
  const usable = hasUsableAccount(harness);

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

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <ActionForm
        action={launch}
        focusError
        className="flex min-h-0 flex-1 flex-col"
        footerClassName="space-y-2 border-t px-6 py-4"
        footer={
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <LaunchProgress />
            {usable ? (
              <SubmitButton className="w-full sm:w-auto">
                <RocketIcon /> Launch <SubmitShortcut />
              </SubmitButton>
            ) : (
              <>
                <p id={`${id}-no-account`} className="mr-auto text-xs text-warning">
                  A usable {HARNESS_LABELS[harness]} account is needed to launch.
                </p>
                <Button type="button" className="w-full sm:w-auto" disabled aria-describedby={`${id}-no-account`}>
                  <RocketIcon /> Launch
                </Button>
              </>
            )}
          </div>
        }
      >
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="hostId" value={hostId} />
        <LaunchFields>
          <LaunchTaskField idPrefix={id} />
          {harnesses.length > 1 ? (
            <Segmented
              legend="Agent"
              name="harness"
              value={harness}
              onChange={setHarness}
              options={harnesses.map((value) => ({ value, label: HARNESS_LABELS[value] }))}
            />
          ) : (
            <p className="text-sm">
              <input type="hidden" name="harness" value={harness} />
              <span className="text-muted-foreground">Agent:</span> {HARNESS_LABELS[harness]}
            </p>
          )}
          <AccountField key={harness} idPrefix={id} harness={harness} accounts={accounts} onChange={() => {}} />
          <ModelFields key={`${harness}-model`} idPrefix={id} harness={harness} catalog={MODEL_CATALOG} />
          <LaunchAdvanced summary={<span className="text-xs text-muted-foreground">Armada official environment</span>}>
            <p className="text-sm">
              <span className="text-muted-foreground">Environment:</span> Armada official (fetched by your host the
              first time)
            </p>
            {unavailable.length > 0 && (
              <div data-docker-unavailable>
                <p className="font-medium">Not available on Docker hosts yet</p>
                <ul className="mt-2 space-y-1">
                  {unavailable.map((item) => (
                    <li key={item.name}>
                      <span className="font-medium">{item.name}</span>
                      <span className="text-muted-foreground">: {item.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </LaunchAdvanced>
        </LaunchFields>
      </ActionForm>
    </div>
  );
}

/**
 * What a launch is doing while it waits (#1507): the host fetches Armada's image first if it does not have it yet,
 * which can take a few minutes the first time. Always rendered, so a screen reader announces the text when it appears.
 */
function LaunchProgress() {
  const { pending } = useFormStatus();
  return (
    <p role="status" className="mr-auto text-xs text-muted-foreground" data-docker-launch-progress>
      {pending
        ? "Preparing the official Armada environment on your host and starting the sandbox… The first launch can take a few minutes."
        : null}
    </p>
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
