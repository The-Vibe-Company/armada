"use client";

import { CheckCircle2Icon, CircleAlertIcon, Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useActionState, useId, useRef, useState } from "react";
import { buildGolden } from "@/app/actions/goldens";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action";
import { MAX_GOLDEN_REPOS, type RepoRow } from "@/lib/golden-form";
import { cn } from "@/lib/utils";

type Props = {
  mode: "create" | "update";
  orgId: string;
  orgName: string;
  /** Org admins create org goldens; everyone else creates private ones. A hint: the server checks again. */
  isAdmin: boolean;
  /** Update: the golden being rebuilt, its name fixed. */
  name?: string;
  /** Update: the golden's visibility, which a rebuild keeps. */
  visibility?: "org" | "private";
  defaults?: { repos: RepoRow[]; init: string };
};

type KeyedRow = RepoRow & { key: number };

const BUILD_OUTCOME_UNKNOWN =
  "The dashboard lost track of this build before the Armada server answered. It may still finish: refresh the page before trying again.";

/**
 * The golden form: a name, one or more GitHub repositories (branch and directory optional), init commands,
 * a one-off setup script and who sees it. It submits once to the server's secure builder and shows that one
 * request's outcome; while it runs every field is locked, so the same build cannot be sent twice.
 */
export function GoldenForm({ mode, orgId, orgName, isAdmin, name, visibility, defaults }: Props) {
  const id = useId();
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(async (previous, data) => {
    let result: ActionResult;
    try {
      result = await buildGolden(previous, data);
    } catch {
      // The action's function ended without an answer (its time budget, a deploy, the network): the server may
      // still be building. Say so, and send nothing again.
      return { ok: false, error: BUILD_OUTCOME_UNKNOWN };
    }
    // A new golden was built: clear the create form. A rebuild keeps showing what the golden now records.
    if (mode === "create" && result.ok) {
      setGoldenName("");
      setRows([keyed({ url: "", branch: "", dir: "" })]);
      setInit("");
      setSetup("");
    }
    return result;
  }, null);
  const nextKey = useRef(0);
  const keyed = (row: RepoRow): KeyedRow => ({ ...row, key: nextKey.current++ });
  const [rows, setRows] = useState<KeyedRow[]>(() =>
    (defaults?.repos.length ? defaults.repos : [{ url: "", branch: "", dir: "" }]).map(keyed),
  );
  const [chosenVisibility, setChosenVisibility] = useState<"org" | "private">(isAdmin ? "org" : "private");
  // Controlled, so a refused build keeps what was typed (React resets a form after its action).
  const [goldenName, setGoldenName] = useState("");
  const [init, setInit] = useState(defaults?.init ?? "");
  const [setup, setSetup] = useState("");

  const update = (key: number, field: keyof RepoRow, value: string) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, [field]: value } : row)));

  function guard(event: FormEvent<HTMLFormElement>) {
    // The fieldset is disabled while pending; this also stops an Enter press racing the re-render.
    if (pending) event.preventDefault();
  }

  const verb = mode === "create" ? "Build golden" : "Rebuild golden";
  return (
    <form
      action={formAction}
      onSubmit={guard}
      aria-busy={pending}
      aria-label={mode === "create" ? "Create a golden" : `Rebuild ${name}`}
      className="space-y-5"
      data-golden-form={mode}
    >
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="org" value={orgId} />
      <fieldset disabled={pending} className="space-y-5 disabled:opacity-70">
        {mode === "create" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                name="name"
                value={goldenName}
                onChange={(event) => setGoldenName(event.target.value)}
                required
                maxLength={120}
                placeholder="web-app"
                autoComplete="off"
              />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Who sees it</legend>
              <div className="flex flex-wrap gap-4 pt-1 text-sm">
                <label className={cn("flex items-center gap-2", !isAdmin && "text-muted-foreground")}>
                  <input
                    type="radio"
                    name="visibility"
                    value="org"
                    checked={chosenVisibility === "org"}
                    onChange={() => setChosenVisibility("org")}
                    disabled={!isAdmin}
                    aria-describedby={`${id}-visibility-hint`}
                  />
                  Everyone in {orgName}
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="visibility"
                    value="private"
                    checked={chosenVisibility === "private"}
                    onChange={() => setChosenVisibility("private")}
                  />
                  Only me
                </label>
              </div>
              <p id={`${id}-visibility-hint`} className="text-xs text-muted-foreground">
                {isAdmin ? "Org goldens are visible to every member." : "Only an org admin creates org goldens."}
              </p>
            </fieldset>
          </div>
        ) : (
          <>
            <input type="hidden" name="name" value={name ?? ""} />
            <p className="text-sm text-muted-foreground">
              The rebuild keeps the name <span className="font-medium text-foreground">{name}</span> and its{" "}
              {visibility === "private" ? "private" : "org"} visibility, and replaces the snapshot when it succeeds.
            </p>
          </>
        )}

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Repositories</legend>
          <p className="text-xs text-muted-foreground">
            GitHub repositories you can access, as owner/repo or a github.com URL. Branch defaults to main; the
            directory under /home/user defaults to the repository name.
          </p>
          <ol className="space-y-3">
            {rows.map((row, index) => (
              <li
                key={row.key}
                className="grid gap-2 rounded-md border p-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
              >
                <div className="space-y-1">
                  <Label htmlFor={`${id}-url-${row.key}`}>Repository {index + 1}</Label>
                  <Input
                    id={`${id}-url-${row.key}`}
                    name="repo_url"
                    value={row.url}
                    onChange={(event) => update(row.key, "url", event.target.value)}
                    placeholder="owner/repo"
                    autoComplete="off"
                    spellCheck={false}
                    required={index === 0}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-branch-${row.key}`}>Branch</Label>
                  <Input
                    id={`${id}-branch-${row.key}`}
                    name="repo_branch"
                    value={row.branch}
                    onChange={(event) => update(row.key, "branch", event.target.value)}
                    placeholder="main"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-dir-${row.key}`}>Directory</Label>
                  <Input
                    id={`${id}-dir-${row.key}`}
                    name="repo_dir"
                    value={row.dir}
                    onChange={(event) => update(row.key, "dir", event.target.value)}
                    placeholder="repo name"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove repository ${index + 1}`}
                  disabled={rows.length === 1}
                  onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}
                >
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={rows.length >= MAX_GOLDEN_REPOS}
            onClick={() => setRows((current) => [...current, keyed({ url: "", branch: "", dir: "" })])}
          >
            <PlusIcon /> Add repository
          </Button>
        </fieldset>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${id}-init`}>Init commands</Label>
            <Textarea
              id={`${id}-init`}
              name="init"
              rows={4}
              value={init}
              onChange={(event) => setInit(event.target.value)}
              placeholder={"bun install\nmake deps"}
              spellCheck={false}
              aria-describedby={`${id}-init-hint`}
              className="font-mono text-xs"
            />
            <p id={`${id}-init-hint`} className="text-xs text-muted-foreground">
              One per line. Recorded in the golden and run when it is built. Never put a secret here.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-setup`}>Setup script</Label>
            <Textarea
              id={`${id}-setup`}
              name="setup"
              value={setup}
              onChange={(event) => setSetup(event.target.value)}
              rows={4}
              placeholder="Optional shell script, run once after cloning"
              spellCheck={false}
              aria-describedby={`${id}-setup-hint`}
              className="font-mono text-xs"
            />
            <p id={`${id}-setup-hint`} className="text-xs text-muted-foreground">
              Runs in the builder after the init commands; the server appends it to the recorded init commands.
            </p>
          </div>
        </div>
      </fieldset>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2Icon className="animate-spin" />}
          {pending ? (mode === "create" ? "Building…" : "Rebuilding…") : verb}
        </Button>
        <BuildStatus pending={pending} state={state} />
      </div>
    </form>
  );
}

function BuildStatus({ pending, state }: { pending: boolean; state: ActionResult | null }) {
  if (pending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        The Armada server is cloning, scanning and snapshotting in a disposable builder. This can take several minutes;
        keep this page open.
      </p>
    );
  if (!state) return null;
  return state.ok ? (
    <p role="status" className="flex items-center gap-2 text-sm text-success">
      <CheckCircle2Icon className="size-4 shrink-0" />
      {state.message}
    </p>
  ) : (
    <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
      <CircleAlertIcon className="size-4 shrink-0" />
      {state.error}
    </p>
  );
}
