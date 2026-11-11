"use client";

import { PencilIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { readSkillDefaults, saveSkillDefaults } from "@/app/actions/skill-defaults";
import { SkillPicker } from "@/components/skill-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import type { SkillDefaultsTarget } from "@/lib/skill-defaults";

type State = { state: "loading" } | { state: "error"; error: string } | { state: "ready"; skills: string[] };

/** One independent defaults record; the catalog is fetched only if its editor's picker is opened. */
export function SkillDefaultsCard({
  orgId,
  scope,
  goldenId,
  title,
  description,
  canManage,
}: {
  orgId: string;
  scope: "personal" | "org" | "golden";
  goldenId?: string;
  title: string;
  description: string;
  canManage: boolean;
}) {
  const [state, setState] = useState<State>({ state: "loading" });
  const [open, setOpen] = useState(false);
  const generation = useRef(0);
  const target = useCallback(
    (): SkillDefaultsTarget =>
      scope === "golden" ? { org: orgId, scope, goldenId: goldenId ?? "" } : { org: orgId, scope },
    [orgId, scope, goldenId],
  );
  const load = useCallback(async () => {
    const current = ++generation.current;
    setState({ state: "loading" });
    try {
      const result = await readSkillDefaults(target());
      if (generation.current !== current) return;
      setState(result.ok ? { state: "ready", skills: result.skills } : { state: "error", error: result.error });
    } catch {
      if (generation.current === current)
        setState({ state: "error", error: "Default skills could not be loaded. Try again before editing." });
    }
  }, [target]);
  useEffect(() => {
    void load();
    return () => {
      ++generation.current;
    };
  }, [load]);
  const toast = useToast();
  const renderedGeneration = generation.current;

  return (
    <section aria-label={title} className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-medium">{title}</h2>
          <p className="text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
        {canManage && (
          <Dialog
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (next) void load();
            }}
          >
            <DialogTrigger asChild>
              <Button type="button" size="sm" variant="outline" data-edit-skill-defaults={scope}>
                <PencilIcon /> Edit defaults
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>{`Edit ${title.toLowerCase()}`}</DialogTitle>
                <DialogDescription>
                  Choose exact versions for future launches. Removing every pin clears this defaults record.
                </DialogDescription>
              </DialogHeader>
              {state.state === "ready" ? (
                <DefaultsForm
                  key={generation.current}
                  target={target()}
                  initial={state.skills}
                  onSaved={(skills) => {
                    if (generation.current !== renderedGeneration) return;
                    ++generation.current;
                    setState({ state: "ready", skills });
                    setOpen(false);
                    toast({ tone: "success", title: "Default skills saved." });
                  }}
                />
              ) : (
                <div className="space-y-3">
                  <ReadState state={state} retry={() => void load()} />
                  <Button disabled className="w-full">
                    Save defaults
                  </Button>
                </div>
              )}
            </DialogContent>
          </Dialog>
        )}
      </div>
      {state.state === "ready" ? (
        state.skills.length ? (
          <ul className="space-y-1.5" aria-label={title}>
            {state.skills.map((pin) => (
              <li key={pin} className="break-all font-mono text-xs text-muted-foreground">
                {pin}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No default skills configured.</p>
        )
      ) : (
        <ReadState state={state} retry={() => void load()} />
      )}
      {!canManage && (
        <p className="text-xs text-muted-foreground">Only an organization admin can change these defaults.</p>
      )}
    </section>
  );
}

function ReadState({ state, retry }: { state: State; retry: () => void }) {
  return state.state === "loading" ? (
    <p role="status" className="text-xs text-muted-foreground">
      Loading default skills…
    </p>
  ) : state.state === "error" ? (
    <div className="space-y-2">
      <p role="alert" className="text-xs text-destructive">
        {state.error}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={retry}>
        Try again
      </Button>
    </div>
  ) : null;
}

function DefaultsForm({
  target,
  initial,
  onSaved,
}: {
  target: SkillDefaultsTarget;
  initial: string[];
  onSaved: (pins: string[]) => void;
}) {
  const [pins, setPins] = useState(() => [...initial]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        setError(null);
        try {
          const result = await saveSkillDefaults(target, pins);
          if (result.ok) onSaved(result.skills);
          else setError(result.error);
        } catch {
          setError("Default skills could not be confirmed. Reload before saving again.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <SkillPicker orgId={target.org} value={pins} onChange={setPins} disabled={saving} />
      {error && (
        <p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-destructive outline-none">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save defaults"}
        </Button>
      </div>
    </form>
  );
}
