"use client";

import { MODEL_CATALOG } from "@armada/core";
import { RocketIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef } from "react";
import { launchOnDockerHost } from "@/app/actions/docker-hosts";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AccountField } from "@/components/launch-dialog";
import { ModelFields } from "@/components/model-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action";
import { dockerLaunchKeyStorage, UNKNOWN_DOCKER_LAUNCH } from "@/lib/docker-launch";
import { LAUNCH_KEY_FIELD, type LaunchKey, launchKeyFor } from "@/lib/launch-key";
import { accountProblem, accountsFor, type LaunchAccounts } from "@/lib/model-accounts";

/**
 * Launch a sandbox on one Docker host (#1380): Codex from a digest-pinned plain image, with a model account and an
 * optional task. A Docker host has no environment (golden) yet, so this launch starts from the host, not from an
 * environment. What Docker cannot do yet is listed with the server's own reasons. A successful launch navigates to
 * the new sandbox.
 */
export function DockerLaunchDialog({
  orgId,
  hostId,
  hostName,
  accounts,
  unavailable,
}: {
  orgId: string;
  hostId: string;
  hostName: string;
  accounts: LaunchAccounts;
  unavailable: { name: string; reason: string }[];
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" data-docker-launch={hostId}>
          <RocketIcon /> Launch on this host
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Launch on {hostName}</DialogTitle>
          <DialogDescription>Codex in a private sandbox, started from a plain image on this host.</DialogDescription>
        </DialogHeader>
        <DockerLaunchForm orgId={orgId} hostId={hostId} accounts={accounts} unavailable={unavailable} />
      </DialogContent>
    </Dialog>
  );
}

function DockerLaunchForm({
  orgId,
  hostId,
  accounts,
  unavailable,
}: {
  orgId: string;
  hostId: string;
  accounts: LaunchAccounts;
  unavailable: { name: string; reason: string }[];
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const storage = dockerLaunchKeyStorage(hostId);
  // The key of the submission in flight, so its answer decides whether the key is kept.
  const sent = useRef<LaunchKey | null>(null);
  const usable =
    accounts.state === "ready" &&
    accountsFor(accounts.accounts, "codex").some((account) => accountProblem(account, accounts.now) === null);

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    // A refused launch keeps what was typed, so the person fixes the cause and launches again.
    const keep = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    // The request key is the server's `requestId`. It is reused only after a launch nobody knows the outcome of,
    // and only with the same choices, even if the dialog was closed in between: the server then reconciles it
    // instead of starting a second sandbox. Any other answer makes the next launch a new request.
    const keyed = (event: Event) => {
      if (!(event instanceof FormDataEvent)) return;
      const key = launchKeyFor(readKey(storage), event.formData.entries());
      sent.current = key;
      writeKey(storage, null);
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
      const result = await launchOnDockerHost(previous, data);
      if (!result.ok && result.error === UNKNOWN_DOCKER_LAUNCH) writeKey(storage, sent.current);
      return result;
    },
    [storage],
  );

  return (
    <div ref={root}>
      <ActionForm
        action={launch}
        focusError
        className="space-y-4"
        footer={
          <div className="flex items-center justify-end gap-3">
            {usable ? (
              <SubmitButton>
                <RocketIcon /> Launch
              </SubmitButton>
            ) : (
              <>
                <p id={`${id}-no-account`} className="mr-auto text-xs text-warning">
                  A usable Codex account is needed to launch.
                </p>
                <Button type="button" disabled aria-describedby={`${id}-no-account`}>
                  <RocketIcon /> Launch
                </Button>
              </>
            )}
          </div>
        }
      >
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="hostId" value={hostId} />
        <div className="space-y-2">
          <Label htmlFor={`${id}-prompt`}>Task</Label>
          <Textarea
            id={`${id}-prompt`}
            name="prompt"
            rows={3}
            placeholder="What should the agent do? Leave empty to start idle."
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-image`}>Image</Label>
          <Input
            id={`${id}-image`}
            name="image"
            required
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
            placeholder="buildpack-deps@sha256:…"
            aria-describedby={`${id}-image-hint`}
          />
          <p id={`${id}-image-hint`} className="text-xs text-muted-foreground">
            A plain Linux image pinned by digest, with HTTPS CA roots. Armada installs its runtime and Codex in it.
          </p>
        </div>
        <p className="text-sm">
          <span className="text-muted-foreground">Agent:</span> Codex{" "}
          <span className="text-muted-foreground">(the only agent on Docker hosts for now)</span>
        </p>
        <AccountField idPrefix={id} harness="codex" accounts={accounts} onChange={() => {}} />
        <ModelFields idPrefix={id} harness="codex" catalog={MODEL_CATALOG} />
        {unavailable.length > 0 && (
          <details className="rounded-md border p-3 text-sm" data-docker-unavailable>
            <summary className="cursor-pointer text-muted-foreground">Not available on Docker hosts yet</summary>
            <ul className="mt-2 space-y-1">
              {unavailable.map((item) => (
                <li key={item.name}>
                  <span className="font-medium">{item.name}</span>
                  <span className="text-muted-foreground">: {item.reason}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </ActionForm>
    </div>
  );
}

function readKey(name: string): LaunchKey | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(name) ?? "null");
    if (
      typeof value === "object" &&
      value !== null &&
      "key" in value &&
      "fingerprint" in value &&
      typeof value.key === "string" &&
      typeof value.fingerprint === "string"
    )
      return { key: value.key, fingerprint: value.fingerprint };
  } catch {
    // Storage refused or unreadable: the launch is a new request.
  }
  return null;
}

function writeKey(name: string, key: LaunchKey | null): void {
  try {
    if (key) sessionStorage.setItem(name, JSON.stringify(key));
    else sessionStorage.removeItem(name);
  } catch {
    // Storage refused: a later retry is a new request, as without this dialog's memory.
  }
}
