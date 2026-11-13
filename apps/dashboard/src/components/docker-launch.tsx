"use client";

import { MODEL_CATALOG } from "@armada/core";
import { RocketIcon } from "lucide-react";
import { useEffect, useId, useRef } from "react";
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
import { LAUNCH_KEY_FIELD, type LaunchKey, launchKeyFor } from "@/lib/launch-key";
import type { LaunchAccounts } from "@/lib/model-accounts";

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
  const launchKey = useRef<LaunchKey | null>(null);

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    // A refused launch keeps what was typed, so the person fixes the cause and launches again.
    const keep = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    // The request key is the server's `requestId`: kept while the choices stay the same, so launching again after
    // an unanswered launch is reconciled by the server instead of starting a second sandbox.
    const keyed = (event: Event) => {
      if (!(event instanceof FormDataEvent)) return;
      launchKey.current = launchKeyFor(launchKey.current, event.formData.entries());
      event.formData.set(LAUNCH_KEY_FIELD, launchKey.current.key);
    };
    node.addEventListener("reset", keep, true);
    node.addEventListener("formdata", keyed, true);
    return () => {
      node.removeEventListener("reset", keep, true);
      node.removeEventListener("formdata", keyed, true);
    };
  }, []);

  return (
    <div ref={root}>
      <ActionForm
        action={launchOnDockerHost}
        focusError
        className="space-y-4"
        footer={
          <div className="flex justify-end">
            <SubmitButton>
              <RocketIcon /> Launch
            </SubmitButton>
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
