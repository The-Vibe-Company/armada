"use client";

import { type Harness, ORCHESTRATOR_DEFAULTS, type SandboxProviderId } from "@armada/core";
import { ChevronRightIcon, Loader2Icon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
import { createOrchestrator, type OrchestratorResult } from "@/app/actions/orchestrators";
import { type ModelCatalog, ModelFields } from "@/components/model-fields";
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
import { NativeSelect } from "@/components/ui/native-select";
import { PROVIDER_LABELS } from "@/lib/golden-form";
import { HARNESS_LABELS } from "@/lib/labels";
import { idleChoices, type ModelAccount } from "@/lib/orchestrators";

export type CreateGolden = { id: string; name: string; provider: SandboxProviderId; repositories: string[] };

/**
 * Creates an orchestrator: a name, the golden it runs from (which fixes the provider), the agent, its model and the
 * named account that pays for it. The working directory and the inactivity period are folded away; their defaults
 * are the server's. The `Idempotency-Key` stays the same while an attempt's outcome is unknown, so sending again
 * never creates two.
 */
export function CreateOrchestrator({
  orgId,
  goldens,
  accounts,
  catalog,
}: {
  orgId: string;
  goldens: CreateGolden[];
  accounts: { ok: true; accounts: ModelAccount[] } | { ok: false; reason: string };
  catalog: ModelCatalog;
}) {
  const id = useId();
  const [state, formAction, pending] = useActionState<OrchestratorResult | null, FormData>(createOrchestrator, null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [goldenId, setGoldenId] = useState(goldens[0]?.id ?? "");
  const [harness, setHarness] = useState<Harness>("claude");
  const golden = goldens.find((row) => row.id === goldenId);
  const usable = accounts.ok ? accounts.accounts.filter((account) => account.harness === harness) : [];
  const preferred = usable.find((account) => account.isDefault) ?? usable[0];

  /** The request last sent. After an unknown outcome it is sent again exactly, fields locked, so it applies once. */
  const sent = useRef<FormData | null>(null);
  const [editing, setEditing] = useState(false);
  const uncertain = state !== null && !state.ok && state.failure === "uncertain" && !editing;

  // A definite answer ends the attempt; an unknown one keeps the key for the retry.
  useEffect(() => {
    setEditing(false);
    if (state && !state.ok && state.failure !== "uncertain") setKey(crypto.randomUUID());
  }, [state]);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon /> New orchestrator
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New orchestrator</DialogTitle>
          <DialogDescription>One lasting conversation that launches and follows workers for you.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          // Not `action`: React resets an action form once it settles, and a refused attempt must keep its fields.
          onSubmit={(event) => {
            event.preventDefault();
            const data = uncertain && sent.current ? sent.current : new FormData(event.currentTarget);
            sent.current = data;
            startTransition(() => formAction(data));
          }}
        >
          <input type="hidden" name="org" value={orgId} />
          <input type="hidden" name="provider" value={golden?.provider ?? ""} />
          <input type="hidden" name="idempotency_key" value={key} />
          {/* Locked while an attempt's outcome is unknown: a changed request under the same key would be refused. */}
          <fieldset disabled={uncertain} className="min-w-0 space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input id={`${id}-name`} name="name" required maxLength={120} placeholder="Release coordinator" />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-golden`}>Golden</Label>
              <NativeSelect
                id={`${id}-golden`}
                name="golden"
                value={goldenId}
                onChange={(event) => setGoldenId(event.target.value)}
              >
                {goldens.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name} · {PROVIDER_LABELS[row.provider]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-harness`}>Agent</Label>
              <NativeSelect
                id={`${id}-harness`}
                name="harness"
                value={harness}
                onChange={(event) => setHarness(event.target.value as Harness)}
              >
                {(Object.keys(catalog) as Harness[]).map((value) => (
                  <option key={value} value={value}>
                    {HARNESS_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <ModelFields key={harness} idPrefix={id} harness={harness} catalog={catalog} />
            <div className="space-y-2">
              <Label htmlFor={`${id}-account`}>Model account</Label>
              <NativeSelect
                key={harness}
                id={`${id}-account`}
                name="account"
                defaultValue={preferred?.id ?? ""}
                disabled={usable.length === 0}
                aria-describedby={usable.length === 0 ? `${id}-account-hint` : undefined}
              >
                {usable.length === 0 && <option value="">No named account</option>}
                {usable.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                    {account.scope === "org" ? " (org)" : ""}
                    {account.isDefault ? " · default" : ""}
                  </option>
                ))}
              </NativeSelect>
              {usable.length === 0 && (
                <p id={`${id}-account-hint`} className="text-xs text-muted-foreground">
                  {accounts.ok ? (
                    <>
                      An orchestrator runs on a named {HARNESS_LABELS[harness]} account.{" "}
                      <Link href="/credentials" className="font-medium underline underline-offset-4">
                        Add one
                      </Link>
                    </>
                  ) : (
                    accounts.reason
                  )}
                </p>
              )}
            </div>
            <details className="group rounded-md border px-3 py-2">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
                Advanced
              </summary>
              <div className="space-y-4 pt-3 pb-1">
                <div className="space-y-2">
                  <Label htmlFor={`${id}-repo`}>Working directory</Label>
                  <NativeSelect
                    key={goldenId}
                    id={`${id}-repo`}
                    name="repo"
                    defaultValue={golden?.repositories.length === 1 ? golden.repositories[0] : ""}
                    disabled={!golden || golden.repositories.length === 0}
                  >
                    <option value="">Default directory</option>
                    {golden?.repositories.map((dir) => (
                      <option key={dir} value={dir}>
                        {dir}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-idle`}>Stop after inactivity</Label>
                  <NativeSelect
                    id={`${id}-idle`}
                    name="idle_seconds"
                    defaultValue={String(ORCHESTRATOR_DEFAULTS.idleSeconds)}
                    aria-describedby={`${id}-idle-hint`}
                  >
                    {idleChoices().map((choice) => (
                      <option key={choice.seconds} value={choice.seconds}>
                        {choice.label}
                      </option>
                    ))}
                  </NativeSelect>
                  <p id={`${id}-idle-hint`} className="text-xs text-muted-foreground">
                    Running work, workers and known waits keep it awake. Resuming continues the same conversation.
                  </p>
                </div>
              </div>
            </details>
          </fieldset>
          {state && !state.ok && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={pending || usable.length === 0 || !golden}>
              {pending && <Loader2Icon className="animate-spin" />}
              {uncertain ? "Try again" : "Create"}
            </Button>
            {uncertain && (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setEditing(true);
                  setKey(crypto.randomUUID());
                }}
              >
                Change it instead
              </Button>
            )}
          </div>
          {uncertain && (
            <p className="text-xs text-muted-foreground">
              Trying again sends “{String(sent.current?.get("name") ?? "")}” exactly as before and cannot create it
              twice. Before changing it, check the list: it may already exist.
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
