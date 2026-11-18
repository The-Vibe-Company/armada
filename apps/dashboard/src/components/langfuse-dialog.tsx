"use client";

import { CircleCheckIcon, CircleXIcon, LockIcon } from "lucide-react";
import { type FormEvent, useId, useState, useTransition } from "react";
import { updateLangfuse } from "@/app/actions/langfuse";
import { CreateDialog } from "@/components/create-dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { LangfuseAdmin, LangfuseTest } from "@/lib/langfuse";
import { cn } from "@/lib/utils";

const MODES = [
  {
    mode: "metadata",
    title: "Metadata only",
    description:
      "Timing, model, tokens, cost, turn status and tool names. No prompts, replies, code or tool results leave Armada.",
  },
  {
    mode: "full",
    title: "Full content",
    description:
      "Also sends prompts, agent replies, tool inputs and results. These can include your code, secrets and customer data, readable by everyone in your Langfuse project.",
  },
] as const;

export function LangfuseTestResult({ result, host }: { result: LangfuseTest; host: string }) {
  if (result === "ok") {
    return (
      <p role="status" className="flex gap-2 text-sm text-success">
        <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          <strong>Test passed.</strong> Langfuse accepted these keys.
        </span>
      </p>
    );
  }
  return (
    <p role="alert" className="flex gap-2 text-sm text-destructive">
      <CircleXIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="break-all sm:break-normal">
        {result === "rejected" ? (
          <>
            <strong>Langfuse rejected these keys.</strong> Copy the public and secret key again from your Langfuse
            project settings, and check that the host matches the project's region.
          </>
        ) : (
          <>
            <strong>Armada could not reach this host.</strong> No answer from {host} within 5 seconds. Check the
            address, and that it accepts HTTPS from the Armada server.
          </>
        )}
      </span>
    </p>
  );
}

export function LangfuseDialog({ org, settings }: { org: string; settings: LangfuseAdmin }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const edit = settings.configured;
  const title = edit ? "Edit Langfuse" : "Connect Langfuse";
  return (
    <CreateDialog
      title={title}
      label={edit ? "Edit" : title}
      description="Armada exports each agent turn in this organization's sandboxes to your Langfuse project as a trace."
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
      dismissible={!busy}
      triggerVariant="outline"
      showPlus={!edit}
      className="sm:max-w-lg"
    >
      {open && <LangfuseForm org={org} settings={settings} close={() => setOpen(false)} setBusy={setBusy} />}
    </CreateDialog>
  );
}

function LangfuseForm({
  org,
  settings,
  close,
  setBusy,
}: {
  org: string;
  settings: LangfuseAdmin;
  close: () => void;
  setBusy: (value: boolean) => void;
}) {
  const edit = settings.configured;
  const id = useId();
  const [replace, setReplace] = useState(!edit);
  const [pending, start] = useTransition();
  const [operation, setOperation] = useState<"save" | "test" | "disconnect">("save");
  const [test, setTest] = useState<{ status: LangfuseTest; host: string }>();
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [disconnectError, setDisconnectError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const button = (event.nativeEvent as SubmitEvent).submitter;
    const testing = button instanceof HTMLButtonElement && button.value === "test";
    setOperation(testing ? "test" : "save");
    setTest(undefined);
    setError("");
    setBusy(true);
    start(async () => {
      try {
        const result = await updateLangfuse(org, testing ? "test" : edit ? "edit" : "connect", data);
        if (!result.ok) setError(result.error);
        else if (result.test) {
          const host = String(data.get("host"));
          setTest({ status: result.test, host: new URL(host).host });
        } else close();
      } catch {
        setError("Armada could not complete the request. Reload this organization before retrying.");
      } finally {
        setBusy(false);
      }
    });
  }

  function disconnect() {
    setDisconnectError("");
    setOperation("disconnect");
    setBusy(true);
    start(async () => {
      try {
        const result = await updateLangfuse(org, "disconnect");
        if (result.ok) close();
        else setDisconnectError(result.error);
      } catch {
        setDisconnectError("Armada could not disconnect Langfuse. Reload this organization before retrying.");
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <form
      className="space-y-4"
      onSubmit={submit}
      onChange={() => {
        setTest(undefined);
        setError("");
      }}
      aria-busy={pending}
    >
      <fieldset disabled={pending} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-host`}>Host</Label>
          <Input
            id={`${id}-host`}
            name="host"
            type="url"
            required
            defaultValue={settings.host}
            aria-invalid={test?.status === "unreachable"}
            aria-describedby={`${id}-host-hint`}
            spellCheck={false}
          />
          <p id={`${id}-host-hint`} className="text-xs text-muted-foreground">
            EU: https://cloud.langfuse.com · US: https://us.cloud.langfuse.com · or your self-hosted address.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-public`}>Public key</Label>
          <Input
            id={`${id}-public`}
            name="publicKey"
            required
            defaultValue={settings.publicKey ?? ""}
            placeholder="pk-lf-…"
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            aria-invalid={test?.status === "rejected"}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={replace ? `${id}-secret` : undefined}>Secret key</Label>
          {replace ? (
            <>
              <Input
                id={`${id}-secret`}
                name="secretKey"
                type="password"
                required
                autoFocus={edit}
                placeholder="sk-lf-…"
                autoComplete="new-password"
                className="font-mono"
                aria-invalid={test?.status === "rejected"}
                aria-describedby={`${id}-secret-hint`}
              />
              <p id={`${id}-secret-hint`} className="text-xs text-muted-foreground">
                Stored encrypted. Once saved, nobody can read it back.
              </p>
            </>
          ) : (
            <div
              className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm aria-invalid:border-destructive"
              aria-invalid={test?.status === "rejected"}
            >
              <LockIcon aria-hidden className="size-4 text-muted-foreground" />
              <span>
                Stored <span className="text-muted-foreground">· value hidden</span>
              </span>
              <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setReplace(true)}>
                Replace
              </Button>
            </div>
          )}
          {edit && (
            <p className="text-xs text-muted-foreground">Keys come in pairs: if you change one, replace the other.</p>
          )}
        </div>
        <fieldset className="space-y-2">
          <legend id={`${id}-mode`} className="text-sm font-medium">
            What to export
          </legend>
          <RadioGroup
            name="contentMode"
            defaultValue={settings.contentMode}
            aria-labelledby={`${id}-mode`}
            onValueChange={() => {
              setTest(undefined);
              setError("");
            }}
          >
            {MODES.map(({ mode, title, description }) => (
              <Label
                key={mode}
                className="flex cursor-pointer items-start gap-2 rounded-md border p-3 has-[[data-state=checked]]:border-ring has-[[data-state=checked]]:bg-muted/40"
              >
                <RadioGroupItem value={mode} className="mt-0.5" />
                <span className="grid gap-1">
                  <span>{title}</span>
                  <span className="text-xs leading-relaxed font-normal text-muted-foreground">{description}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        </fieldset>
      </fieldset>
      {test ? (
        <LangfuseTestResult result={test.status} host={test.host} />
      ) : (
        <p className="text-xs text-muted-foreground">Test the connection checks host and keys. Sends no trace.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div
        className={cn(
          "flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center",
          edit ? "sm:justify-between" : "sm:justify-end",
        )}
      >
        {edit && (
          <AlertDialog
            open={confirm}
            onOpenChange={(next) => {
              if (!pending) setConfirm(next);
            }}
          >
            <AlertDialogTrigger asChild>
              <Button type="button" variant="ghost" className="text-destructive" disabled={pending}>
                Disconnect
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect Langfuse?</AlertDialogTitle>
                <AlertDialogDescription>
                  Export stops and the stored keys are deleted. Traces already in Langfuse stay.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {disconnectError && (
                <p role="alert" className="text-sm text-destructive">
                  {disconnectError}
                </p>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                <Button type="button" variant="destructive" onClick={disconnect} disabled={pending}>
                  {pending && operation === "disconnect" ? "Disconnecting…" : "Disconnect"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="submit" disabled={pending}>
            {pending && operation === "save" ? "Saving…" : edit ? "Save" : "Connect and start exporting"}
          </Button>
          <Button type="submit" value="test" variant="outline" disabled={pending}>
            {pending && operation === "test" ? "Testing…" : "Test the connection"}
          </Button>
        </div>
      </div>
    </form>
  );
}
