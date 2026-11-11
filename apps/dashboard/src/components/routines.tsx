"use client";

import { Clock3Icon, PauseIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
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
      label="New"
      title="New routine"
      description="A template and a prompt, on a schedule. Created paused so you can check it first."
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
      <fieldset disabled={pending} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${base}-name`}>Name</Label>
            <Input
              id={`${base}-name`}
              name="name"
              required
              maxLength={200}
              placeholder="Daily code review"
              autoComplete="off"
            />
          </div>
          {isAdmin ? (
            <div className="space-y-1.5">
              <Label htmlFor={`${base}-scope`}>Visibility</Label>
              <NativeSelect
                id={`${base}-scope`}
                name="scope"
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value);
                  setTemplate("");
                }}
              >
                <option value="personal">Personal</option>
                <option value="org">Organization</option>
              </NativeSelect>
              <p className="text-xs text-muted-foreground">Cannot change later.</p>
            </div>
          ) : (
            <input type="hidden" name="scope" value="personal" />
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${base}-template`}>Template</Label>
          <NativeSelect
            id={`${base}-template`}
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
                {x.name} — revision {x.currentRevision} ({x.scope === "org" ? "organization" : "personal"})
              </option>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            {selected
              ? `Pinned to revision ${selected.currentRevision}. Later template changes will not update this routine.`
              : "Choose a published template. Its revision stays pinned."}
          </p>
          {!available.length && (
            <p className="text-sm text-muted-foreground">
              No eligible templates.{" "}
              <Link href="/templates" className="underline">
                Create a template
              </Link>{" "}
              first.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${base}-prompt`}>Prompt</Label>
          <Textarea
            id={`${base}-prompt`}
            name="prompt"
            required
            maxLength={32000}
            rows={3}
            placeholder="What should the agent do each time?"
          />
          <p className="text-xs text-muted-foreground">
            Readable configuration, not a place for secrets. Whitespace is preserved.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${base}-interval`}>Interval (hours)</Label>
          <Input
            id={`${base}-interval`}
            className="max-w-32"
            type="number"
            name="interval"
            min={1}
            max={720}
            step={1}
            defaultValue={24}
            required
          />
          <p className="text-xs text-muted-foreground">
            Minimum one hour. Enabling starts the first interval, not an immediate launch.
          </p>
        </div>
        <details className="rounded-lg border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">
            Limits <span className="ml-1 font-normal text-muted-foreground">Lifetime and daily cap</span>
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${base}-ttl`}>TTL (minutes)</Label>
              <Input
                id={`${base}-ttl`}
                type="number"
                name="ttl"
                required
                min={5}
                max={1440}
                step={1}
                defaultValue={60}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${base}-cap`}>Max runs per day</Label>
              <Input id={`${base}-cap`} type="number" name="cap" required min={1} max={24} step={1} defaultValue={24} />
            </div>
          </div>
        </details>
      </fieldset>
      {result && !result.ok && (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3 border-t pt-4">
        <p className="text-xs text-muted-foreground">Runs as you, with your current access.</p>
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
          : "Routine enabled. Its first interval starts now."
      }
    >
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="id" value={item.id} />
      <input type="hidden" name="version" value={item.version} />
      <input type="hidden" name="operation" value={enabled ? "pause" : "enable"} />
      <SubmitButton variant="outline" size="sm" aria-label={`${enabled ? "Pause" : "Enable"} ${item.name}`}>
        {enabled ? <PauseIcon /> : <PlayIcon />}
        {enabled ? "Pause" : "Enable"}
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
        Latest 100 decisions. Launch success is separate from the original prompt outcome.
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
                        ? "Admitted"
                        : run.state === "reconciling"
                          ? "Uncertain"
                          : run.state === "skipped"
                            ? "Skipped"
                            : "Failed"
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
                <span>Agent: {run.taskState ?? "not observed"}</span>
                {run.missedIntervals > 0 && <span>{run.missedIntervals} missed intervals</span>}
                {run.sandboxId && (
                  <Link className="text-foreground underline underline-offset-4" href={`/sandboxes/${run.sandboxId}`}>
                    View sandbox
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
