"use client";

import { HARNESSES } from "@armada/core";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState, useTransition } from "react";
import { createTrigger } from "@/app/actions/inbound-triggers";
import { CopyButton } from "@/components/copy-button";
import { CreateDialog } from "@/components/create-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { HARNESS_LABELS } from "@/lib/labels";
import type { TemplateHeader } from "@/lib/templates";

const unknownOutcome = "Could not confirm creation. Close the dialog and check the trigger list before trying again.";

export function CreateTriggerDialog({
  org,
  templates,
}: {
  org: string;
  templates: Pick<TemplateHeader, "id" | "name" | "scope">[] | null;
}) {
  const router = useRouter();
  const fields = useId();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ signingSecret?: string; error?: string; outcomeUnknown?: boolean }>({});
  const secret = result.signingSecret;

  function changeOpen(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) {
      setResult({});
      if (secret || result.outcomeUnknown) router.refresh();
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || secret || result.outcomeUnknown) return;
    const form = new FormData(event.currentTarget);
    setResult({});
    startTransition(async () => {
      try {
        setResult(await createTrigger(org, form));
      } catch {
        setResult({ outcomeUnknown: true });
      }
    });
  }

  return (
    <CreateDialog
      label="Create trigger"
      title={secret ? "New signing key" : "Create inbound trigger"}
      description={
        secret ? (
          <span tabIndex={-1} ref={(instructions) => instructions?.focus()}>
            Copy this key now. It is shown only once.
          </span>
        ) : (
          "Bind a webhook to a launch template."
        )
      }
      open={open}
      onOpenChange={changeOpen}
      dismissible={!pending && !secret}
      showCloseButton={!pending && !secret}
      className="sm:max-w-md"
    >
      {secret ? (
        <>
          <div className="flex items-center gap-2">
            <code className="min-w-0 break-all rounded-md bg-muted p-2 text-sm">{secret}</code>
            <CopyButton value={secret} label="Copy signing key" />
          </div>
          <div className="flex justify-end">
            <Button onClick={() => changeOpen(false)}>Done</Button>
          </div>
        </>
      ) : templates?.length ? (
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={pending || result.outcomeUnknown} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`${fields}-template`}>Launch template</Label>
              <NativeSelect id={`${fields}-template`} name="templateId" required defaultValue="" className="w-full">
                <option value="" disabled>
                  Choose a template
                </option>
                {templates.map(({ id, name, scope }) => (
                  <option key={id} value={id}>
                    {name} ({scope === "org" ? "Organization" : "Personal"})
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${fields}-pool`}>Account pool harness</Label>
              <NativeSelect id={`${fields}-pool`} name="poolHarness" required defaultValue="" className="w-full">
                <option value="" disabled>
                  Choose a harness
                </option>
                {HARNESSES.map((harness) => (
                  <option key={harness} value={harness}>
                    {HARNESS_LABELS[harness]}
                  </option>
                ))}
              </NativeSelect>
              <p className="text-xs text-muted-foreground">
                Use the template’s harness. Your default account must be available for it.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor={`${fields}-rate`}>Deliveries per minute</Label>
                <Input
                  id={`${fields}-rate`}
                  name="ratePerMinute"
                  type="number"
                  min={1}
                  max={2147483647}
                  defaultValue={25}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${fields}-concurrency`}>Active launches</Label>
                <Input
                  id={`${fields}-concurrency`}
                  name="concurrency"
                  type="number"
                  min={1}
                  max={2147483647}
                  defaultValue={2}
                  required
                />
              </div>
            </div>
          </fieldset>
          {(result.error || result.outcomeUnknown) && (
            <p role="alert" className="text-sm text-destructive">
              {result.error ?? unknownOutcome}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={() => changeOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || result.outcomeUnknown}>
              {pending ? "Creating…" : "Create trigger"}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          {templates
            ? "Create a launch template before adding a trigger."
            : "Could not load launch templates. Reload to try again."}
        </p>
      )}
    </CreateDialog>
  );
}
