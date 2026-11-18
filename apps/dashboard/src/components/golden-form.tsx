"use client";

import { type GoldenBuildStatus, parseGoldenConfig, type SandboxProviderId } from "@armada/core";
import { CheckCircle2Icon, CircleAlertIcon, Loader2Icon, LockIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type ComponentProps,
  type FormEvent,
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  buildGolden,
  cancelGoldenBuild,
  findActiveGoldenBuild,
  goldenBuildStatus,
  recoverGoldenBuild,
} from "@/app/actions/goldens";
import { SnapshotPlacementWord, useSnapshotPlacement } from "@/components/docker-snapshot-forms";
import { LaunchDialog } from "@/components/launch-dialog";
import { LaunchChoice } from "@/components/launch-surface";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { usePreservedActionForm } from "@/components/use-preserved-action-form";
import type { ActionResult } from "@/lib/action";
import {
  type CapacityState,
  GOLDEN_PROVIDERS,
  MAX_GOLDEN_REPOS,
  PROVIDER_LABELS,
  type RepoRow,
} from "@/lib/golden-form";
import { replaceResourceUrl } from "@/lib/resource-history";
import { ITEM_PARAM } from "@/lib/resource-list";
import { snapshotBuildFeedback } from "@/lib/snapshot-build-feedback";
import { cn } from "@/lib/utils";

type Props = {
  mode: "create" | "update";
  launch?: Omit<ComponentProps<typeof LaunchDialog>, "golden" | "provider" | "repositories">;
  githubConnected?: boolean;
  replacements?: { id: string; name: string; visibility: "org" | "private" }[];
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
  embedded?: {
    name: string;
    onBuilding: (name: string) => void;
    onSaved: (result: NonNullable<GoldenBuildStatus["result"]>, provider: SandboxProviderId) => Promise<void>;
  };
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
export function SnapshotDetails({ openInComposer, children }: { openInComposer: boolean; children: React.ReactNode }) {
  if (!openInComposer) return children;
  return (
    <details className="space-y-3">
      <summary className="cursor-pointer text-sm font-medium">More options</summary>
      {children}
    </details>
  );
}

function RepositoryDetails({ embedded, children }: { embedded: boolean; children: React.ReactNode }) {
  return embedded ? (
    children
  ) : (
    <details className="contents">
      <summary className="col-start-3 row-start-1 cursor-pointer py-2 text-sm">Details</summary>
      {children}
    </details>
  );
}

export function GoldenForm(props: Props) {
  return <ScopedGoldenForm key={buildScope(props)} {...props} />;
}

function ScopedGoldenForm({
  mode,
  launch,
  githubConnected = true,
  replacements = [],
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
  embedded,
}: Props) {
  const placement = useSnapshotPlacement();
  const id = useId();
  const router = useRouter();
  useEffect(() => {
    if (embedded) return;
    const refresh = () => router.refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [router, embedded]);
  // Each form tracks its own build in the page URL: this org's create form, or the rebuild of this one golden.
  // Another org's form or another golden's never reads, polls or resubmits it.
  const scope = buildScope({ mode, orgId, goldenId });
  const jobParam = `build.${scope}`;
  const keyParam = `build-key.${scope}`;
  const providerParam = `build-provider.${scope}`;
  const [admissionKey, setAdmissionKey] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [observed, setObserved] = useState<GoldenBuildStatus | null>(null);
  const [pollError, setPollError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [finding, setFinding] = useState(false);
  const findInFlight = useRef(false);
  const cancelInFlight = useRef(false);
  const statusReadEpoch = useRef(0);
  // The provider of the admitted job: a rebuild's is the stored golden's; a create's is what was submitted.
  const [admittedProvider, setAdmittedProvider] = useState<SandboxProviderId | null>(
    mode === "update" ? (provider ?? null) : null,
  );
  const refreshStatus = useCallback(async (jobId: string) => {
    const epoch = statusReadEpoch.current;
    try {
      const next = await goldenBuildStatus(jobId);
      if (epoch !== statusReadEpoch.current) return;
      setObserved(next);
      setPollError("");
    } catch {
      if (epoch === statusReadEpoch.current)
        setPollError("Status unavailable. The build may still run; check this job again, do not resubmit.");
    }
  }, []);
  const jobId = observed?.jobId;
  const jobState = observed?.state;
  useEffect(() => {
    // A read started for this scope is ignored once the scope is gone: a late answer never lands in another form.
    let active = true;
    const epoch = statusReadEpoch.current;
    const params = new URLSearchParams(window.location.search);
    const savedKey = params.get(keyParam);
    setAdmissionKey(savedKey ?? crypto.randomUUID());
    setSubmitted(Boolean(savedKey || params.get(jobParam)));
    const savedProvider = params.get(providerParam);
    if (mode === "create" && (savedProvider === "boat" || savedProvider === "modal"))
      setAdmittedProvider(savedProvider);
    const savedJob = params.get(jobParam);
    if (savedJob)
      void goldenBuildStatus(savedJob)
        .then((status) => {
          if (!active || epoch !== statusReadEpoch.current) return;
          setObserved(status);
          setPollError("");
        })
        .catch(() => {
          if (active && epoch === statusReadEpoch.current)
            setPollError("Status unavailable. The build may still run; check this job again, do not resubmit.");
        });
    else if (savedKey)
      void recoverGoldenBuild(savedKey, orgId)
        .then((recovered) => {
          if (!active || epoch !== statusReadEpoch.current) return;
          setObserved(recovered);
          rememberJob(jobParam, recovered.jobId);
        })
        .catch(() => {
          if (active && epoch === statusReadEpoch.current)
            setPollError("No visible admission receipt yet. Recover using the saved key; do not blindly resubmit.");
        });
    return () => {
      active = false;
      statusReadEpoch.current++;
    };
  }, [orgId, jobParam, keyParam, providerParam, mode]);
  useEffect(() => {
    if (!jobId || !jobState || !["queued", "running"].includes(jobState)) return;
    let active = true;
    // Follow the build until it finishes; closing the form does not stop the server build.
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelInFlight.current) {
        if (active) timer = setTimeout(poll, 2000);
        return;
      }
      const epoch = statusReadEpoch.current;
      try {
        const next = await goldenBuildStatus(jobId);
        if (active && epoch === statusReadEpoch.current) {
          setObserved(next);
          setPollError("");
          if (["queued", "running"].includes(next.state)) timer = setTimeout(poll, 2000);
        } else if (active) timer = setTimeout(poll, 2000);
      } catch {
        if (active && epoch === statusReadEpoch.current)
          setPollError("Polling paused. Check this job again; do not resubmit.");
      }
    };
    timer = setTimeout(poll, 2000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [jobId, jobState]);

  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(async (previous, data) => {
    setSubmitted(true);
    embedded?.onBuilding(String(data.get("name") ?? ""));
    let result: ActionResult;
    const replacement = data.get("replacement");
    if (typeof replacement === "string" && replacements.some((item) => item.id === replacement)) {
      data.set("mode", "update");
      data.set("golden", replacement);
    }
    // The key is saved in the URL before the request, so an answer lost in transit is recovered, not resubmitted.
    const submitted = data.get("provider");
    const admissionUrl = new URL(window.location.href);
    admissionUrl.searchParams.set(keyParam, admissionKey);
    if (mode === "create" && typeof submitted === "string") admissionUrl.searchParams.set(providerParam, submitted);
    replaceResourceUrl(admissionUrl);
    try {
      result = await buildGolden(previous, data);
    } catch {
      // The action's function ended without an answer (its time budget, a deploy, the network): the server may
      // still be building. Say so, and send nothing again.
      embedded?.onBuilding("");
      return { ok: false, error: BUILD_OUTCOME_UNKNOWN };
    }
    if (result.ok && result.build) {
      if (mode === "create" && (submitted === "boat" || submitted === "modal")) setAdmittedProvider(submitted);
      setObserved(result.build);
      rememberJob(jobParam, result.build.jobId);
    }
    if (!result.ok) embedded?.onBuilding("");
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
  const contextProvider = placement?.value === "boat" || placement?.value === "modal" ? placement.value : null;
  const chosenProvider =
    contextProvider ?? (choice !== null && providers.includes(choice) ? choice : (providers[0] ?? null));
  // Controlled, so a refused build keeps what was typed (React resets a form after its action).
  const formRef = usePreservedActionForm();
  const [goldenName, setGoldenName] = useState(embedded?.name ?? "");
  const [init, setInit] = useState(defaults?.init ?? "");

  const update = (key: number, field: keyof RepoRow, value: string) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, [field]: value } : row)));

  function guard(event: FormEvent<HTMLFormElement>) {
    // The fieldset is disabled while pending; this also stops an Enter press racing the re-render.
    if (pending || finding || findInFlight.current || !canStart || !githubConnected) event.preventDefault();
  }

  const verb = mode === "create" ? "Build snapshot" : "Rebuild snapshot";
  // An admitted job that has not finished keeps the form locked: nothing is edited or sent again meanwhile.
  const jobActive = observed !== null && ["queued", "running", "recovery_required"].includes(observed.state);
  // The placement picker is shared with the own-server form; submission still names the exact cloud provider.
  const providerChoice = chosenProvider && (
    <>
      <input type="hidden" name="provider" value={chosenProvider} />
      {placement ? (
        <SnapshotPlacementWord />
      ) : (
        <LaunchChoice
          inline
          label="Where to build"
          presentation="chips"
          value={chosenProvider}
          onChange={(value) => setChosenProvider(value as SandboxProviderId)}
          options={providers.map((value) => ({ value, label: `${PROVIDER_LABELS[value]} cloud` }))}
        />
      )}
    </>
  );
  const reported = useRef("");
  const [completionError, setCompletionError] = useState("");
  useEffect(() => {
    if (!embedded || !observed || reported.current === observed.jobId) return;
    if (observed.state === "failed" || observed.state === "recovery_required") {
      reported.current = observed.jobId;
      embedded.onBuilding("");
    } else if (observed.state === "succeeded" && observed.result) {
      const actualProvider = observed.provider ?? admittedProvider ?? chosenProvider;
      if (!actualProvider) return;
      reported.current = observed.jobId;
      const url = new URL(window.location.href);
      for (const param of [keyParam, jobParam, providerParam]) url.searchParams.delete(param);
      replaceResourceUrl(url);
      void embedded.onSaved(observed.result, actualProvider).catch(() => {
        setCompletionError("The snapshot was saved. Open Snapshots to locate it.");
        embedded.onBuilding("");
      });
    } else {
      embedded.onBuilding(goldenName);
    }
  }, [embedded, observed, admittedProvider, chosenProvider, goldenName, keyParam, jobParam, providerParam]);

  if (observed?.state === "succeeded" && observed.result) {
    return (
      <div className="space-y-4" role="status">
        <p className="font-medium">{observed.result.name} is ready</p>
        {completionError && <p role="alert">{completionError}</p>}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Button variant="ghost" asChild>
            <a href="/snapshots">View snapshots</a>
          </Button>
          {launch && (
            <LaunchDialog
              {...launch}
              golden={observed.result.name}
              provider={admittedProvider ?? chosenProvider ?? "boat"}
              repositories={readyRepositories(rows)}
            />
          )}
        </div>
      </div>
    );
  }
  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={guard}
      aria-busy={pending}
      aria-label={mode === "create" ? "Create a snapshot" : `Rebuild ${name} on ${PROVIDER_LABELS[provider ?? "boat"]}`}
      className="space-y-4"
      data-golden-form={mode}
    >
      <input type="hidden" name="idempotencyKey" value={admissionKey} />
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="org" value={orgId} />
      <fieldset disabled={pending || jobActive} className="space-y-4 disabled:opacity-70">
        {mode === "create" ? (
          <div className="space-y-2">
            <div className="space-y-2">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                aria-label="Snapshot name"
                name="name"
                value={goldenName}
                onChange={(event) => setGoldenName(event.target.value)}
                required
                maxLength={120}
                placeholder="web-app"
                autoComplete="off"
                className="h-[38px] font-mono"
              />{" "}
            </div>
            <p className="flex items-start gap-1.5 text-xs">
              <LockIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
              Where it is built is permanent. Its owner can make it private later.
            </p>
            {!isAdmin && (
              <p className="text-xs text-muted-foreground">
                Only an organization admin can create a snapshot for everyone.
              </p>
            )}
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

        {embedded && (
          <div className="space-y-1">
            <p className="text-sm font-medium">Where to build</p>
            {providerChoice}
          </div>
        )}
        <SnapshotDetails openInComposer={Boolean(embedded)}>
          <fieldset className="relative space-y-3">
            <legend className="text-sm font-medium">Repositories</legend>
            <ol className="space-y-3">
              {rows.map((row, index) => (
                <li
                  key={row.key}
                  className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 border-b py-2"
                >
                  <div className="min-w-0 space-y-1">
                    <Label className="sr-only" htmlFor={`${id}-url-${row.key}`}>
                      Repository {index + 1}
                    </Label>
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
                  <span className="text-xs text-muted-foreground">{row.branch || "Default branch"}</span>
                  <RepositoryDetails embedded={Boolean(embedded)}>
                    <div className="col-span-full row-start-2 grid gap-3 py-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor={`${id}-branch-${row.key}`}>Branch</Label>
                        <Input
                          id={`${id}-branch-${row.key}`}
                          name="repo_branch"
                          value={row.branch}
                          onChange={(event) => update(row.key, "branch", event.target.value)}
                          placeholder="Default branch"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`${id}-dir-${row.key}`}>Folder on the machine</Label>
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-muted-foreground">/home/user/</span>
                          <Input
                            id={`${id}-dir-${row.key}`}
                            name="repo_dir"
                            value={row.dir}
                            onChange={(event) => update(row.key, "dir", event.target.value)}
                            pattern="[^/\\\\]+"
                            placeholder={
                              row.url
                                .replace(/\.git$/, "")
                                .split("/")
                                .pop() || "repo"
                            }
                          />
                        </div>
                      </div>
                      <div className="space-y-1 sm:col-span-2">
                        <Label htmlFor={`${id}-history-${row.key}`}>History to download</Label>
                        <NativeSelect
                          id={`${id}-history-${row.key}`}
                          name="repo_history"
                          value={row.history || "full"}
                          onChange={(event) => update(row.key, "history", event.target.value)}
                        >
                          <option value="full">Everything</option>
                          <option value="shallow">Latest commit only</option>
                        </NativeSelect>
                        <p className="text-xs text-muted-foreground">
                          Armada checks what it downloads for leaked GitHub, Skillpack and Armada tokens before saving.
                          Latest commit only is faster on large repositories.
                        </p>
                      </div>
                    </div>
                  </RepositoryDetails>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="col-start-4 row-start-1"
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

          {mode === "create" && (
            <div className="space-y-2">
              {" "}
              {!embedded && (
                <>
                  <div className="pt-2 text-sm font-medium">Machine</div>
                  {providerChoice}
                </>
              )}
              <div className="pt-2 text-sm font-medium">Visible to</div>
              <LaunchChoice
                inline
                label="Who sees it"
                presentation="chips"
                value={chosenVisibility}
                onChange={(value) => setChosenVisibility(value as "org" | "private")}
                options={[
                  {
                    value: "org",
                    label: `everyone in ${orgName}`,
                    ...(!isAdmin ? { reason: "Only an organization admin can create a snapshot for everyone." } : {}),
                  },
                  { value: "private", label: "only you" },
                ]}
              />
              <input type="hidden" name="visibility" value={chosenVisibility} />
            </div>
          )}
        </SnapshotDetails>
        <div className="space-y-2">
          <Label htmlFor={`${id}-init`}>
            Setup script <span className="font-normal text-muted-foreground">optional</span>
          </Label>
          <Textarea
            id={`${id}-init`}
            name="init"
            rows={4}
            value={init}
            onChange={(event) => setInit(event.target.value)}
            placeholder={"(cd web && bun install)\n(cd api && bun install)"}
            spellCheck={false}
            aria-describedby={`${id}-init-hint`}
            className="font-mono text-xs"
          />
          <p id={`${id}-init-hint`} className="text-xs text-muted-foreground">
            One per line, each starting from the home folder (up to 32 lines). Never put a password or a key here; an
            agent that needs one gets it as a secret in a template.
          </p>
        </div>
      </fieldset>

      {!githubConnected && (
        <p role="alert" className="text-sm">
          GitHub is not connected, so Armada cannot download your repositories.{" "}
          <a href="/github/connect" target="_blank" rel="noreferrer" className="underline">
            Connect GitHub
          </a>
          . Opens in a new tab. This form keeps what you typed.
        </p>
      )}
      {mode === "create" && chosenProvider === "boat" && ["full", "legacy"].includes(capacities?.boat?.kind ?? "") && (
        <div role="status" className="space-y-2 rounded-md border p-3 text-sm">
          <p>
            Boat allows{" "}
            {capacities?.boat && "capacity" in capacities.boat ? capacities.boat.capacity : "a limited number of"}{" "}
            {capacities?.boat && "capacity" in capacities.boat && capacities.boat.capacity === 1
              ? "snapshot"
              : "snapshots"}{" "}
            here and the limit is reached.
          </p>
          <div className="flex flex-wrap gap-2">
            {replacements.map((item) => (
              <Button
                key={item.id}
                type="submit"
                name="replacement"
                value={item.id}
                variant="outline"
                disabled={pending || jobActive || !githubConnected}
              >
                Replace {item.name}
              </Button>
            ))}
            {providers.includes("modal") && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => (placement ? placement.onChange("modal") : setChosenProvider("modal"))}
              >
                Build on Modal cloud
              </Button>
            )}
          </div>
          {(pending || jobActive || !githubConnected) && (
            <p className="text-xs text-muted-foreground">
              {!githubConnected
                ? "Connect GitHub before replacing a snapshot so Armada can download the repositories."
                : "Wait for the current build to finish before replacing a snapshot."}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Replacing keeps the existing name and who sees it, and puts these repositories in it. Templates using it
            start from the new build. Owner or admin only.
          </p>
        </div>
      )}
      <div className="space-y-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <Button
            type="submit"
            disabled={
              !admissionKey ||
              pending ||
              finding ||
              jobActive ||
              !canStart ||
              !githubConnected ||
              (mode === "create" &&
                chosenProvider === "boat" &&
                ["full", "legacy"].includes(capacities?.boat?.kind ?? ""))
            }
          >
            {pending && <Loader2Icon className="animate-spin" />}
            {pending ? (mode === "create" ? "Building…" : "Rebuilding…") : verb}
          </Button>
          {observed && ["queued", "running", "succeeded"].includes(observed.state) && (
            <ol aria-label="Build progress" className="space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <span aria-hidden>✓</span>
                <span>Request accepted</span>
              </li>
              <li className="flex items-start gap-2">
                <span aria-hidden>{observed.state === "succeeded" ? "✓" : "○"}</span>
                <span>
                  {observed.state === "queued" ? "Waiting for a builder" : "Downloading repositories, running commands"}
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span aria-hidden>{observed.state === "succeeded" ? "✓" : "○"}</span>
                <span>Saved</span>
              </li>
            </ol>
          )}
          <BuildStatus
            pending={pending}
            active={observed?.state === "queued" || observed?.state === "running"}
            state={observed ? snapshotBuildFeedback(observed, mode, admittedProvider) : state}
          />
          {mode === "update" && goldenId && !observed && (
            <Button
              type="button"
              variant="outline"
              disabled={finding || pending}
              onClick={() => {
                if (findInFlight.current || pending) return;
                findInFlight.current = true;
                const epoch = ++statusReadEpoch.current;
                const lookupUrl = new URL(window.location.href);
                const sameScope = () => {
                  const currentUrl = new URL(window.location.href);
                  return (
                    epoch === statusReadEpoch.current &&
                    currentUrl.pathname === lookupUrl.pathname &&
                    currentUrl.searchParams.get(ITEM_PARAM) === lookupUrl.searchParams.get(ITEM_PARAM)
                  );
                };
                setFinding(true);
                startTransition(async () => {
                  try {
                    const result = await findActiveGoldenBuild(goldenId, orgId);
                    if (!sameScope()) return;
                    if (result.ok && result.build) {
                      setObserved(result.build);
                      rememberJob(jobParam, result.build.jobId);
                      setPollError("");
                    } else if (!result.ok) setPollError(result.error);
                  } catch {
                    if (sameScope())
                      setPollError("Active build lookup is unavailable. Check again before submitting another build.");
                  } finally {
                    findInFlight.current = false;
                    if (epoch === statusReadEpoch.current) setFinding(false);
                  }
                });
              }}
            >
              {finding && <Loader2Icon className="animate-spin" aria-hidden />}
              {finding ? "Finding…" : "Find active build"}
            </Button>
          )}
          {observed && (
            <Button
              type="button"
              variant="outline"
              disabled={cancelling}
              onClick={() => void refreshStatus(observed.jobId)}
            >
              Check build status
            </Button>
          )}
          {observed?.state === "queued" && (
            <Button
              type="button"
              variant="outline"
              disabled={cancelling}
              onClick={() => {
                if (cancelInFlight.current) return;
                cancelInFlight.current = true;
                statusReadEpoch.current++;
                setCancelling(true);
                const jobId = observed.jobId;
                startTransition(async () => {
                  try {
                    const result = await cancelGoldenBuild(jobId, orgId);
                    if (result.ok && result.build) {
                      setObserved(result.build);
                      setPollError("");
                    } else if (!result.ok) setPollError(result.error);
                  } catch {
                    setPollError("Cancellation could not be confirmed. Check build status before trying again.");
                  } finally {
                    cancelInFlight.current = false;
                    setCancelling(false);
                  }
                });
              }}
            >
              {cancelling && <Loader2Icon className="animate-spin" aria-hidden />}
              {cancelling ? "Cancelling…" : "Cancel queued build"}
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
                replaceResourceUrl(url);
              }}
            >
              Try again
            </Button>
          )}
        </div>
        {pollError && <p role="alert">{pollError}</p>}
        {submitted && (
          <>
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="text-xs">
                  Technical details
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-1 px-3 py-2 text-xs text-muted-foreground">
                <p>
                  Request reference: <code className="break-all">{admissionKey}</code>
                </p>
                {observed && (
                  <p>
                    Build reference: <code className="break-all">{observed.jobId}</code>
                  </p>
                )}
              </CollapsibleContent>
            </Collapsible>
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span>If the build response is missing, check this saved request before starting another build.</span>
              {!observed && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  disabled={finding || pending}
                  onClick={async () => {
                    const epoch = statusReadEpoch.current;
                    try {
                      const recovered = await recoverGoldenBuild(admissionKey, orgId);
                      if (epoch !== statusReadEpoch.current) return;
                      setObserved(recovered);
                      rememberJob(jobParam, recovered.jobId);
                      setPollError("");
                    } catch {
                      if (epoch !== statusReadEpoch.current) return;
                      setPollError(
                        "No saved build could be confirmed yet. Keep this page and check again before starting another build.",
                      );
                    }
                  }}
                >
                  Check saved build
                </Button>
              )}
            </p>
          </>
        )}
      </div>
    </form>
  );
}
/** Records an admitted or recovered job in this form's URL scope, so a reload reads it instead of resubmitting. */
function rememberJob(param: string, jobId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(param, jobId);
  replaceResourceUrl(url);
}

function BuildStatus({
  pending,
  active = false,
  state,
}: {
  pending: boolean;
  active?: boolean;
  state: ActionResult | null;
}) {
  if (pending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Building. This can take several minutes and continues if you close this page.
      </p>
    );
  if (!state) return null;
  return state.ok ? (
    <p
      role="status"
      className={cn("flex items-center gap-2 text-sm", active ? "text-muted-foreground" : "text-success")}
    >
      {active ? (
        <Loader2Icon aria-hidden className="size-4 shrink-0 motion-safe:animate-spin" />
      ) : (
        <CheckCircle2Icon aria-hidden className="size-4 shrink-0" />
      )}
      {state.message}
    </p>
  ) : (
    <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
      <CircleAlertIcon className="size-4 shrink-0" />
      {state.error}
    </p>
  );
}

function readyRepositories(rows: RepoRow[]): string[] {
  try {
    return parseGoldenConfig({
      repos: rows
        .filter((row) => row.url.trim())
        .map((row) => ({
          url: /^[\w.-]+\/[\w.-]+$/.test(row.url.trim()) ? `https://github.com/${row.url.trim()}.git` : row.url.trim(),
          ...(row.dir.trim() ? { dir: row.dir.trim() } : {}),
        })),
      init: [],
    }).repos.map((repo) => repo.dir ?? "");
  } catch {
    return [];
  }
}
