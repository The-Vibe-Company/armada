"use client";

import { Clock3Icon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useActionState, useCallback, useEffect, useId, useMemo, useState } from "react";
import { createRoutine, routineHistory, setRoutineState } from "@/app/actions/routines";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { CreateDialog } from "@/components/create-dialog";
import { useResourceSelected } from "@/components/resource-browser";
import { StateCell } from "@/components/state-cell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { type RoutineItem, runDescription } from "@/lib/routines";
import type { TemplateHeader } from "@/lib/templates";

export function RoutineMark() {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"
    >
      <Clock3Icon className="size-4" />
    </span>
  );
}
export function CreateRoutineDialog(props: { orgId: string; isAdmin: boolean; templates: TemplateHeader[] }) {
  const [open, setOpen] = useState(false),
    [generation, setGeneration] = useState(0);
  const toast = useToast();
  const onDone = useCallback(
    (message: string) => {
      toast({ tone: "success", title: message });
      setOpen(false);
    },
    [toast],
  );
  return (
    <CreateDialog
      label="New routine"
      title="New routine"
      description="Templates launched by themselves, on a schedule."
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setGeneration((x) => x + 1);
      }}
      triggerAttrs={{ "data-new-routine": "" }}
    >
      <RoutineForm key={generation} {...props} onDone={onDone} />
    </CreateDialog>
  );
}
function RoutineForm({
  orgId,
  isAdmin,
  templates,
  onDone,
}: {
  orgId: string;
  isAdmin: boolean;
  templates: TemplateHeader[];
  onDone: (message: string) => void;
}) {
  const [result, action, pending] = useActionState(createRoutine, null),
    [scope, setScope] = useState("personal"),
    [template, setTemplate] = useState("");
  const base = useId(),
    selected = templates.find((x) => x.id === template);
  useEffect(() => {
    if (result?.ok) onDone(result.message);
  }, [result, onDone]);
  const available = templates.filter((x) => scope !== "org" || x.scope === "org");
  return (
    <form action={action} className="space-y-4" data-routine-form>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="revision" value={selected?.currentRevision ?? ""} />
      <fieldset disabled={pending} className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`${base}-interval`}>Every</Label>
          <Input
            id={`${base}-interval`}
            aria-label="Interval in hours"
            className="w-20"
            type="number"
            name="interval"
            min={1}
            max={720}
            step={1}
            defaultValue={24}
            required
          />
          <span>hours, launch</span>
          <NativeSelect
            id={`${base}-template`}
            aria-label="Template"
            className="w-full sm:w-auto sm:max-w-64"
            name="template"
            required
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          >
            <option value="" disabled>
              Choose a template
            </option>
            {available.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </NativeSelect>
          <Label htmlFor={`${base}-prompt`}>with this task:</Label>
        </div>
        {!available.length && (
          <p>
            No eligible templates.{" "}
            <Link href="/templates" className="underline">
              Create a template
            </Link>{" "}
            first.
          </p>
        )}
        <Textarea
          id={`${base}-prompt`}
          name="prompt"
          required
          maxLength={32000}
          rows={3}
          placeholder="What should the agent do each time?"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`${base}-name`}>Call it</Label>
          <Input
            id={`${base}-name`}
            className="w-full sm:w-52"
            name="name"
            required
            maxLength={200}
            placeholder="Daily code review"
            autoComplete="off"
          />
          <span>for</span>
          {isAdmin ? (
            <NativeSelect
              aria-label="Visibility (permanent)"
              className="w-auto"
              name="scope"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value);
                setTemplate("");
              }}
            >
              <option value="personal">only you</option>
              <option value="org">the organization</option>
            </NativeSelect>
          ) : (
            <>
              <input type="hidden" name="scope" value="personal" />
              <span>only you</span>
            </>
          )}
          <Label htmlFor={`${base}-ttl`}>. Each run lasts up to</Label>
          <Input
            id={`${base}-ttl`}
            className="w-24"
            type="number"
            name="ttl"
            required
            min={5}
            max={1440}
            step={1}
            defaultValue={60}
          />
          <span>minutes.</span>
        </div>
        <details>
          <summary className="cursor-pointer text-muted-foreground">Safety limit</summary>
          <div className="mt-3 flex items-center gap-2">
            <Label htmlFor={`${base}-cap`}>At most</Label>
            <Input
              className="w-20"
              id={`${base}-cap`}
              type="number"
              name="cap"
              required
              min={1}
              max={24}
              step={1}
              defaultValue={24}
            />
            <span>runs per rolling 24 hours</span>
          </div>
        </details>
        <p className="text-xs text-muted-foreground">
          The task is readable by anyone who can see the routine: no password or key in it. It keeps the template as it
          is today, even if the template changes later. A routine cannot be edited after creation: you can only switch
          it on or off, or delete it. Visibility is permanent.
        </p>
        <p className="text-xs text-muted-foreground">
          The first run comes one interval after you turn it on. It runs as you, with your accounts and access.
        </p>
      </fieldset>
      {result && !result.ok && (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3 border-t pt-4">
        <p className="text-xs text-muted-foreground">Created switched off; turn it on from the list.</p>
        <SubmitButton disabled={pending || !available.length}>Create routine</SubmitButton>
      </div>
    </form>
  );
}
export function RoutineToggle({ item, orgId }: { item: RoutineItem; orgId: string }) {
  const enabled = item.status === "enabled";
  return (
    <ActionForm
      action={setRoutineState}
      successToast={
        enabled
          ? "Routine paused. Already admitted runs may still finish."
          : "Routine enabled. It will run at its next scheduled time."
      }
    >
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="id" value={item.id} />
      <input type="hidden" name="version" value={item.version} />
      <input type="hidden" name="operation" value={enabled ? "pause" : "enable"} />
      <SubmitButton
        variant="ghost"
        size="sm"
        role="switch"
        aria-checked={enabled}
        aria-label={`Switch ${item.name} ${enabled ? "off" : "on"}`}
      >
        <span
          aria-hidden
          className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 ${enabled ? "bg-emerald-600" : "bg-muted"}`}
        >
          <span className={`size-4 rounded-full bg-background ${enabled ? "translate-x-4" : ""}`} />
        </span>
        {enabled ? "On" : "Off"}
      </SubmitButton>
    </ActionForm>
  );
}
export function RoutineHistory({ id, orgId, version }: { id: string; orgId: string; version: number }) {
  const selected = useResourceSelected(id),
    [refresh, setRefresh] = useState(0),
    [result, setResult] = useState<Awaited<ReturnType<typeof routineHistory>> | null>(null),
    [loading, setLoading] = useState(false);
  const request = useMemo(() => ({ orgId, id, version, refresh }), [orgId, id, version, refresh]);
  useEffect(() => {
    if (!selected) return;
    let current = true;
    setLoading(true);
    void routineHistory(request.orgId, request.id)
      .then((next) => {
        if (current) {
          setResult(next);
          setLoading(false);
        }
      })
      .catch(() => {
        if (current) {
          setResult({ ok: false, error: "Run history could not be loaded. Try again." });
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [selected, request]);
  return (
    <section aria-label="Run history" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Run history</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setRefresh((x) => x + 1)}
          disabled={loading}
          aria-label="Refresh history"
        >
          <RefreshCwIcon className={loading ? "motion-safe:animate-spin" : ""} />
          Refresh
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Latest 100 runs. “Launched” means the sandbox started; what the agent achieved is on the sandbox page.
      </p>
      {loading || !result ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading run history…
        </p>
      ) : result && !result.ok ? (
        <div>
          <p role="alert" className="text-sm text-destructive">
            {result.error}
          </p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setRefresh((x) => x + 1)}>
            Try history again
          </Button>
        </div>
      ) : result?.ok && result.items.length ? (
        <ol className="divide-y rounded-lg border">
          {result.items.map((run) => (
            <li key={run.id} className="space-y-1.5 px-3 py-3" data-routine-run={run.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StateCell
                  tone={
                    run.state === "succeeded"
                      ? "success"
                      : run.state === "failed"
                        ? "destructive"
                        : run.state === "skipped"
                          ? "warning"
                          : "info"
                  }
                  label={
                    run.state === "succeeded"
                      ? "Launched"
                      : run.state === "admitted"
                        ? "Launching"
                        : run.state === "reconciling"
                          ? "Not confirmed"
                          : run.state === "skipped"
                            ? "Skipped"
                            : "Not launched"
                  }
                />
                <time dateTime={run.scheduledDueAt} className="text-xs text-muted-foreground">
                  {new Date(run.scheduledDueAt).toLocaleString("en", {
                    timeZone: "UTC",
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}{" "}
                  UTC
                </time>
              </div>
              <p className="text-sm text-muted-foreground">{runDescription(run)}</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {run.state === "succeeded" && <span>Agent {run.taskState ?? "state not observed"}</span>}
                {run.missedIntervals > 0 && <span>{run.missedIntervals} missed intervals</span>}
                {run.sandboxId && (
                  <Link className="text-foreground underline underline-offset-4" href={`/sandboxes/${run.sandboxId}`}>
                    Open sandbox
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
          No runs yet. The first firing is one interval after enabling.
        </p>
      )}
    </section>
  );
}

export function DeleteRoutine({ item, orgId }: { item: RoutineItem; orgId: string }) {
  const [confirm, setConfirm] = useState(false);
  return confirm ? (
    <div className="space-y-3 border-t pt-4">
      <p className="text-sm">Delete {item.name}? This cannot be undone. Existing sandboxes are not deleted.</p>
      <ActionForm action={setRoutineState} successToast="Routine deleted.">
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="id" value={item.id} />
        <input type="hidden" name="version" value={item.version} />
        <input type="hidden" name="operation" value="delete" />
        <div className="flex gap-2">
          <SubmitButton variant="destructive">Delete routine</SubmitButton>
          <Button type="button" variant="ghost" onClick={() => setConfirm(false)}>
            Cancel
          </Button>
        </div>
      </ActionForm>
    </div>
  ) : (
    <Button variant="ghost" className="text-destructive" onClick={() => setConfirm(true)}>
      Delete routine
    </Button>
  );
}
