"use client";

import type { GoldenBuildStatus, SandboxProviderId } from "@armada/core";
import { goldenBuildFailureText } from "@armada/core";
import { CheckCircle2Icon, CircleAlertIcon, Loader2Icon, LockIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useActionState, useCallback, useEffect, useId, useRef, useState } from "react";
import { buildGolden, goldenBuildStatus, recoverGoldenBuild } from "@/app/actions/goldens";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action";
import {
  type CapacityState,
  GOLDEN_PROVIDERS,
  MAX_GOLDEN_REPOS,
  PROVIDER_LABELS,
  type RepoRow,
} from "@/lib/golden-form";
import { cn } from "@/lib/utils";

type Props = {
  mode: "create" | "update";
  orgId: string;
  orgName: string;
  /** Org admins create org goldens; everyone else creates private ones. A hint: the server checks again. */
  isAdmin: boolean;
  /** Create: each offered provider's capacity as the server read it for this org, or why it is not known. */
  capacities?: Readonly<Partial<Record<SandboxProviderId, CapacityState>>>;
  /**
   * Create: the providers the organization has connected, the only ones a new golden may be built on. One is used
   * without a choice; two are offered; none leaves the form to follow a tracked build only.
   */
  providers?: readonly SandboxProviderId[];
  /** Update: the stored golden's id and provider. The provider of a golden never changes. */
  goldenId?: string;
  provider?: SandboxProviderId;
  /** Update: the golden being rebuilt, its name fixed. */
  name?: string;
  /** Update: the golden's visibility, which a rebuild keeps. */
  visibility?: "org" | "private";
  defaults?: { repos: RepoRow[]; init: string };
  /**
   * The organization's sandbox provider is confirmed (#576). Without it the form still follows a tracked build, but
   * it cannot submit a new one; the server refuses it as well.
   */
  canStart?: boolean;
};

type KeyedRow = RepoRow & { key: number };

const BUILD_OUTCOME_UNKNOWN =
  "The dashboard lost track of this build before the Armada server answered. It may still finish: refresh the page before trying again.";

/**
 * The golden form: a name, one or more GitHub repositories (branch and directory optional), init commands,
 * a one-off setup script and who sees it. It submits once to the server's secure builder and shows that one
 * request's outcome; while it runs every field is locked, so the same build cannot be sent twice.
 */
/** The form's build scope: this org's create form, or the rebuild of one stored golden (its id never changes). */
function buildScope(props: { mode: Props["mode"]; orgId: string; goldenId?: string | undefined }): string {
  return props.mode === "create" ? `create.${props.orgId}` : `rebuild.${props.goldenId ?? ""}`;
}

/**
 * Keyed by its build scope, so switching organization in place (the page re-renders with another org) mounts a new
 * form: the previous org's job, lock, polling and saved key are left behind with the old one, never carried over.
 */
export function GoldenForm(props: Props) {
  return <ScopedGoldenForm key={buildScope(props)} {...props} />;
}

function ScopedGoldenForm({
  mode,
  orgId,
  orgName,
  isAdmin,
  capacities,
  providers = GOLDEN_PROVIDERS,
  goldenId,
  provider,
  name,
  visibility,
  defaults,
  canStart = true,
}: Props) {
  const id = useId();
  // Each form tracks its own build in the page URL: this org's create form, or the rebuild of this one golden.
  // Another org's form or another golden's never reads, polls or resubmits it.
  const scope = buildScope({ mode, orgId, goldenId });
  const jobParam = `build.${scope}`;
  const keyParam = `build-key.${scope}`;
  const providerParam = `build-provider.${scope}`;
  const [admissionKey, setAdmissionKey] = useState("");
  const [observed, setObserved] = useState<GoldenBuildStatus | null>(null);
  const [pollError, setPollError] = useState("");
  // The provider of the admitted job: a rebuild's is the stored golden's; a create's is what was submitted.
  const [admittedProvider, setAdmittedProvider] = useState<SandboxProviderId | null>(
    mode === "update" ? (provider ?? null) : null,
  );
  const refreshStatus = useCallback(async (jobId: string) => {
    try {
      setObserved(await goldenBuildStatus(jobId));
      setPollError("");
    } catch {
      setPollError("Status unavailable. The build may still run; check this job again, do not resubmit.");
    }
  }, []);
  const jobId = observed?.jobId;
  const jobState = observed?.state;
  useEffect(() => {
    // A read started for this scope is ignored once the scope is gone: a late answer never lands in another form.
    let active = true;
    const params = new URLSearchParams(window.location.search);
    const savedKey = params.get(keyParam);
    setAdmissionKey(savedKey ?? crypto.randomUUID());
    const savedProvider = params.get(providerParam);
    if (mode === "create" && (savedProvider === "boat" || savedProvider === "modal"))
      setAdmittedProvider(savedProvider);
    const savedJob = params.get(jobParam);
    if (savedJob)
      void goldenBuildStatus(savedJob)
        .then((status) => {
          if (!active) return;
          setObserved(status);
          setPollError("");
        })
        .catch(() => {
          if (active)
            setPollError("Status unavailable. The build may still run; check this job again, do not resubmit.");
        });
    else if (savedKey)
      void recoverGoldenBuild(savedKey, orgId)
        .then((recovered) => {
          if (!active) return;
          setObserved(recovered);
          rememberJob(jobParam, recovered.jobId);
        })
        .catch(() => {
          if (active)
            setPollError("No visible admission receipt yet. Recover using the saved key; do not blindly resubmit.");
        });
    return () => {
      active = false;
    };
  }, [orgId, jobParam, keyParam, providerParam, mode]);
  useEffect(() => {
    if (!jobId || !jobState || !["queued", "running"].includes(jobState)) return;
    let active = true;
    // A bounded local wait: the job keeps running on the server after it, and "Check build status" reads it again.
    const deadline = Date.now() + 120_000;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await goldenBuildStatus(jobId);
        if (active) {
          setObserved(next);
          setPollError("");
          if (Date.now() < deadline && ["queued", "running"].includes(next.state)) timer = setTimeout(poll, 2000);
        }
      } catch {
        if (active) setPollError("Polling paused. Check this job again; do not resubmit.");
      }
    };
    timer = setTimeout(poll, 2000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [jobId, jobState]);

  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(async (previous, data) => {
    let result: ActionResult;
    // The key is saved in the URL before the request, so an answer lost in transit is recovered, not resubmitted.
    const submitted = data.get("provider");
    const admissionUrl = new URL(window.location.href);
    admissionUrl.searchParams.set(keyParam, admissionKey);
    if (mode === "create" && typeof submitted === "string") admissionUrl.searchParams.set(providerParam, submitted);
    window.history.replaceState(null, "", admissionUrl);
    try {
      result = await buildGolden(previous, data);
    } catch {
      // The action's function ended without an answer (its time budget, a deploy, the network): the server may
      // still be building. Say so, and send nothing again.
      return { ok: false, error: BUILD_OUTCOME_UNKNOWN };
    }
    if (result.ok && result.build) {
      if (mode === "create" && (submitted === "boat" || submitted === "modal")) setAdmittedProvider(submitted);
      setObserved(result.build);
      rememberJob(jobParam, result.build.jobId);
    }
    return result;
  }, null);
  const nextKey = useRef(0);
  const keyed = useCallback((row: RepoRow): KeyedRow => ({ ...row, key: nextKey.current++ }), []);
  const [rows, setRows] = useState<KeyedRow[]>(() =>
    (defaults?.repos.length ? defaults.repos : [{ url: "", branch: "", dir: "" }]).map(keyed),
  );
  const [chosenVisibility, setChosenVisibility] = useState<"org" | "private">(isAdmin ? "org" : "private");
  const [choice, setChosenProvider] = useState<SandboxProviderId | null>(null);
  // A provider disconnected since it was chosen is not kept: the first connected one is used instead.
  const chosenProvider = choice !== null && providers.includes(choice) ? choice : (providers[0] ?? null);
  // Controlled, so a refused build keeps what was typed (React resets a form after its action).
  const [goldenName, setGoldenName] = useState("");
  const [init, setInit] = useState(defaults?.init ?? "");
  const [setup, setSetup] = useState("");

  useEffect(() => {
    if (mode === "create" && observed?.state === "succeeded") {
      setGoldenName("");
      setRows([keyed({ url: "", branch: "", dir: "" })]);
      setInit("");
      setSetup("");
    }
  }, [observed?.state, mode, keyed]);

  const update = (key: number, field: keyof RepoRow, value: string) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, [field]: value } : row)));

  function guard(event: FormEvent<HTMLFormElement>) {
    // The fieldset is disabled while pending; this also stops an Enter press racing the re-render.
    if (pending || !canStart) event.preventDefault();
  }

  const verb = mode === "create" ? "Build golden" : "Rebuild golden";
  // An admitted job that has not finished keeps the form locked: nothing is edited or sent again meanwhile.
  const jobActive = observed !== null && ["queued", "running", "recovery_required"].includes(observed.state);
  const builtOn = admittedProvider ? `${PROVIDER_LABELS[admittedProvider]} ` : "";
  // Two connected providers are a choice above the name; a single one is a fact beside it.
  const providerChoice = chosenProvider && (
    <ProviderChoice
      idPrefix={id}
      value={chosenProvider}
      onChange={setChosenProvider}
      providers={providers}
      capacities={capacities}
    />
  );
  return (
    <form
      action={formAction}
      onSubmit={guard}
      aria-busy={pending}
      aria-label={mode === "create" ? "Create a golden" : `Rebuild ${name} on ${PROVIDER_LABELS[provider ?? "boat"]}`}
      className="space-y-4"
      data-golden-form={mode}
    >
      <input type="hidden" name="idempotencyKey" value={admissionKey} />
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="org" value={orgId} />
      <fieldset disabled={pending || jobActive} className="space-y-4 disabled:opacity-70">
        {mode === "create" && chosenProvider && providers.length > 1 && providerChoice}
        {mode === "create" ? (
          <div
            className={cn(
              "grid gap-4 sm:grid-cols-2",
              providers.length === 1 && "lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:gap-x-6",
            )}
          >
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
              <RadioGroup
                name="visibility"
                value={chosenVisibility}
                onValueChange={(value) => setChosenVisibility(value as "org" | "private")}
                aria-label="Visibility"
                className="flex flex-wrap gap-4 pt-1 text-sm"
              >
                <Label htmlFor={`${id}-visibility-org`} className="flex items-center gap-2 font-normal">
                  <RadioGroupItem
                    id={`${id}-visibility-org`}
                    value="org"
                    disabled={!isAdmin}
                    aria-describedby={`${id}-visibility-hint`}
                  />
                  Everyone in {orgName}
                </Label>
                <Label htmlFor={`${id}-visibility-private`} className="flex items-center gap-2 font-normal">
                  <RadioGroupItem id={`${id}-visibility-private`} value="private" />
                  Only me
                </Label>
              </RadioGroup>
              <p id={`${id}-visibility-hint`} className="max-w-64 text-xs text-muted-foreground">
                {isAdmin ? VISIBILITY_HINT[chosenVisibility] : "Only an org admin creates org goldens."}
              </p>
            </fieldset>
            {providers.length === 1 && providerChoice}
          </div>
        ) : (
          <>
            <input type="hidden" name="golden" value={goldenId ?? ""} />
            <p className="text-sm text-muted-foreground">
              The rebuild keeps the name <span className="font-medium text-foreground">{name}</span>, its{" "}
              {visibility === "private" ? "private" : "org"} visibility and its provider,{" "}
              <span className="font-medium text-foreground">{PROVIDER_LABELS[provider ?? "boat"]}</span>, and replaces
              the snapshot there when it succeeds.
            </p>
          </>
        )}

        <fieldset className="relative space-y-3">
          <legend className="text-sm font-medium">Repositories</legend>
          <p className={cn("-mt-2 text-xs text-muted-foreground", mode === "create" && "sm:pr-40")}>
            owner/repo or a github.com URL. Defaults: branch main, directory /home/user/&lt;repo&gt;.
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
            // After the rows for the keyboard. In the create view, which is wide, it sits beside the legend and costs
            // no line; the rebuild form lives in the narrow row panel and keeps it below.
            className={cn(mode === "create" && "sm:absolute sm:-top-8 sm:right-0")}
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
              One per line, recorded in the golden. Never put a secret here.
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
              Runs after the init commands.
            </p>
          </div>
        </div>
      </fieldset>

      <div className="space-y-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <Button type="submit" disabled={!admissionKey || pending || jobActive || !canStart}>
            {pending && <Loader2Icon className="animate-spin" />}
            {pending ? (mode === "create" ? "Building…" : "Rebuilding…") : verb}
          </Button>
          <BuildStatus
            pending={pending}
            state={
              observed
                ? observed.state === "failed" || observed.state === "recovery_required"
                  ? {
                      ok: false,
                      error: `Build ${observed.jobId}: ${observed.state} (${goldenBuildFailureText(observed)}). Last-good golden retained.`,
                    }
                  : {
                      ok: true,
                      message:
                        observed.state === "succeeded" && observed.result
                          ? `${mode === "create" ? "Built" : "Rebuilt"} ${builtOn}golden '${observed.result.name}' and saved snapshot ${observed.result.snapshot}.`
                          : `Build ${observed.jobId}: ${observed.state} (${observed.phase})`,
                    }
                : state
            }
          />
          {observed && (
            <Button type="button" variant="outline" onClick={() => void refreshStatus(observed.jobId)}>
              Check build status
            </Button>
          )}
          {observed && ["succeeded", "failed"].includes(observed.state) && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setObserved(null);
                const key = crypto.randomUUID();
                setAdmissionKey(key);
                const url = new URL(window.location.href);
                url.searchParams.delete(jobParam);
                url.searchParams.delete(providerParam);
                url.searchParams.set(keyParam, key);
                window.history.replaceState(null, "", url);
              }}
            >
              New build request
            </Button>
          )}
        </div>
        {pollError && <p role="alert">{pollError}</p>}
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>
            Admission key <span className="font-mono">{admissionKey}</span>: keep it to recover an uncertain admission,
            never resubmit blindly.
          </span>
          {!observed && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={async () => {
                try {
                  const recovered = await recoverGoldenBuild(admissionKey, orgId);
                  setObserved(recovered);
                  rememberJob(jobParam, recovered.jobId);
                  setPollError("");
                } catch {
                  setPollError(
                    "No visible admission receipt yet. Keep this key and check again; do not blindly resubmit.",
                  );
                }
              }}
            >
              Recover admission by key
            </Button>
          )}
        </p>
      </div>
    </form>
  );
}

/** What the chosen visibility means for an admin, who may change it later from the golden's panel. */
const VISIBILITY_HINT: Record<"org" | "private", string> = {
  org: "Visible to every member. You can make it private later.",
  private: "Only you see it. You can share it with the org later.",
};

const CAPACITY_HINT: Record<CapacityState["kind"], (state: CapacityState) => string> = {
  available: (state) =>
    state.kind === "available" ? `${state.used} of ${state.capacity} goldens visible to you.` : "",
  full: () => "At its golden limit: rebuild the existing golden instead.",
  legacy: () => "Over its golden limit: rebuild an existing golden instead.",
  unknown: () => "No golden limit reported.",
  unavailable: (state) => (state.kind === "unavailable" ? `Unavailable: ${state.reason}` : ""),
};

/**
 * Where a new golden is built. Each option shows that provider's capacity as the server read it for this org;
 * an unavailable one (for example not configured for the org) says so. Nothing falls back to the other provider.
 */
function ProviderChoice({
  idPrefix,
  value,
  onChange,
  providers,
  capacities,
}: {
  idPrefix: string;
  value: SandboxProviderId;
  onChange: (provider: SandboxProviderId) => void;
  providers: readonly SandboxProviderId[];
  capacities: Props["capacities"];
}) {
  if (providers.length === 1) {
    const capacity = capacities?.[value];
    const hint = capacity ? CAPACITY_HINT[capacity.kind](capacity) : "";
    const warn = capacity?.kind === "unavailable" || capacity?.kind === "full" || capacity?.kind === "legacy";
    return (
      <div className="space-y-2" data-provider-fixed={value}>
        <input type="hidden" name="provider" value={value} />
        <p className="text-sm font-medium">Provider</p>
        <p className="flex flex-wrap items-center gap-2 pt-1 text-sm">
          {PROVIDER_LABELS[value]}
          <Permanent />
        </p>
        {hint && <p className={cn("max-w-56 text-xs", warn ? "text-warning" : "text-muted-foreground")}>{hint}</p>}
      </div>
    );
  }
  return (
    <fieldset className="space-y-2">
      <legend className="flex flex-wrap items-center gap-2 text-sm font-medium">
        Provider <Permanent />
      </legend>
      <input type="hidden" name="provider" value={value} />
      <RadioGroup
        name={`${idPrefix}-provider`}
        value={value}
        onValueChange={(next) => onChange(next as SandboxProviderId)}
        aria-label="Provider"
        className="sm:grid-cols-2"
      >
        {providers.map((option) => {
          const capacity = capacities?.[option];
          const hint = capacity ? CAPACITY_HINT[capacity.kind](capacity) : "";
          const warn = capacity?.kind === "unavailable" || capacity?.kind === "full" || capacity?.kind === "legacy";
          return (
            <Label
              key={option}
              htmlFor={`${idPrefix}-provider-choice-${option}`}
              className={cn(
                "relative flex cursor-pointer gap-3 rounded-md border p-3 text-sm transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
                value === option ? "border-primary bg-accent" : "hover:bg-accent/50",
              )}
              data-provider-choice={option}
            >
              <RadioGroupItem
                id={`${idPrefix}-provider-choice-${option}`}
                value={option}
                aria-describedby={`${idPrefix}-provider-${option}`}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block font-medium">{PROVIDER_LABELS[option]}</span>
                <span
                  id={`${idPrefix}-provider-${option}`}
                  className={cn("block text-xs", warn ? "text-warning" : "text-muted-foreground")}
                >
                  {hint}
                </span>
              </span>
            </Label>
          );
        })}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">The same name may exist once on each provider.</p>
    </fieldset>
  );
}

/** Marks the one choice of the create form that no later action changes: where the golden is built. */
function Permanent() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning"
      data-permanent
    >
      <LockIcon aria-hidden className="size-3" />
      Cannot be changed later
    </span>
  );
}

/** Records an admitted or recovered job in this form's URL scope, so a reload reads it instead of resubmitting. */
function rememberJob(param: string, jobId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(param, jobId);
  window.history.replaceState(null, "", url);
}

function BuildStatus({ pending, state }: { pending: boolean; state: ActionResult | null }) {
  if (pending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Building. This can take several minutes and continues if you close this page.
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
