"use client";

import { type DockerSnapshotRecord, parseSnapshotConfig } from "@armada/core";
import { LockIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { buildDockerSnapshot, rebuildDockerSnapshot } from "@/app/actions/docker-snapshots";
import { SnapshotDetails } from "@/components/golden-form";
import { LaunchDialog } from "@/components/launch-dialog";
import { LaunchChoice } from "@/components/launch-surface";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useMutationState } from "@/components/use-mutation-state";
import { isUuid } from "@/lib/action";
import { type DockerHost, hostBuildBlocker } from "@/lib/docker-hosts";
import { goldenRequest, type RepoRow } from "@/lib/golden-form";

type SnapshotPlacement = {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; reason?: string }[];
};
const PlacementContext = createContext<SnapshotPlacement | null>(null);
export function useSnapshotPlacement() {
  return useContext(PlacementContext);
}
export function SnapshotPlacementWord() {
  const placement = useSnapshotPlacement();
  return placement ? <LaunchChoice presentation="chips" inline label="Where to build" {...placement} /> : null;
}

/** One create dialog, with the same provider choice for cloud and host-local snapshots. */
export type EmbeddedSnapshotBuild = {
  repository: string;
  name: string;
  onBuilding: (name: string) => void;
  readDocker: (id: string) => Promise<{ building?: boolean; failed?: boolean; reason?: string } | undefined>;
};

export function SnapshotCreateChoice({
  cloudForms,
  hosts,
  orgId,
  isAdmin,
  canBuild,
  githubConnected = true,
  snapshots = [],
  launch,
  embedded,
}: {
  cloudForms: Partial<Record<"boat" | "modal", ReactNode>>;
  hosts: DockerHost[];
  orgId: string;
  isAdmin: boolean;
  canBuild: boolean;
  githubConnected?: boolean;
  snapshots?: DockerSnapshotRecord[];
  embedded?: EmbeddedSnapshotBuild | undefined;
  launch?: Omit<ComponentProps<typeof LaunchDialog>, "golden" | "provider" | "repositories" | "snapshotId">;
}) {
  const cloud = (Object.keys(cloudForms) as ("boat" | "modal")[]).slice(0, 1);
  const [provider, setProvider] = useState<string>(
    cloud[0] ?? hosts.find((host) => host.state === "online")?.id ?? hosts[0]?.id ?? "",
  );
  const options = [
    ...Object.keys(cloudForms).map((value) => ({ value, label: `${value === "boat" ? "Boat" : "Modal"} cloud` })),
    ...hosts.map((host) => {
      const reason = hostBuildBlocker(host);
      return {
        value: host.id,
        label: `Docker host ${host.name ?? host.id}`,
        ...(reason === null ? {} : { reason }),
      };
    }),
  ];
  const docker = hosts.some((host) => host.id === provider);
  return (
    <PlacementContext.Provider value={{ value: provider, onChange: setProvider, options }}>
      <div className="space-y-4">
        <div hidden={!docker}>
          <DockerSnapshotForm
            hosts={hosts}
            orgId={orgId}
            isAdmin={isAdmin}
            canBuild={canBuild}
            githubConnected={githubConnected}
            snapshots={snapshots}
            embedded={embedded}
            {...(launch ? { launch } : {})}
          />
        </div>
        {cloud.map((value) => (
          <div key={value} hidden={docker}>
            {cloudForms[value]}
          </div>
        ))}
      </div>
    </PlacementContext.Provider>
  );
}

function DockerRepositoryDetails({ embedded, children }: { embedded: boolean; children: ReactNode }) {
  if (embedded) return children;
  return (
    <details>
      <summary className="cursor-pointer text-sm">Details</summary>
      {children}
    </details>
  );
}
function DockerSnapshotForm({
  hosts,
  orgId,
  isAdmin,
  canBuild,
  githubConnected = true,
  snapshots = [],
  launch,
  embedded,
}: {
  hosts: DockerHost[];
  orgId: string;
  isAdmin: boolean;
  canBuild: boolean;
  githubConnected?: boolean;
  snapshots?: DockerSnapshotRecord[];
  embedded?: EmbeddedSnapshotBuild | undefined;
  launch?: Omit<ComponentProps<typeof LaunchDialog>, "golden" | "provider" | "repositories" | "snapshotId">;
}) {
  const placement = useSnapshotPlacement();
  const [hostId, setHostId] = useState(hosts.find((host) => host.state === "online")?.id ?? "");
  const [visibility, setVisibility] = useState("private");
  const [result, action, pending] = useMutationState(buildDockerSnapshot);
  const [config, setConfig] = useState("");
  const [buildName, setBuildName] = useState(embedded?.name ?? "");
  const [embeddedFailed, setEmbeddedFailed] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [repos, setRepos] = useState<(RepoRow & { key: string })[]>([
    { key: "first", url: embedded?.repository ?? "", branch: "", dir: "", history: "full" },
  ]);
  const [commands, setCommands] = useState("");
  const parsed = goldenRequest({
    mode: "create",
    name: "snapshot",
    org: orgId,
    provider: "boat",
    visibility: "private",
    repos,
    init: commands,
    setup: "",
  });
  const generated = parsed.ok ? JSON.stringify(parsed.value.body.config) : "";
  const updateRepo = (index: number, field: keyof RepoRow, value: string) =>
    setRepos((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  useEffect(() => {
    if (embedded) return;
    const refresh = () => router.refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  });
  const [fileError, setFileError] = useState("");
  const [requestId, setRequestId] = useState("");
  const form = useRef<HTMLFormElement>(null),
    close = useRef<HTMLButtonElement>(null);
  const router = useRouter(),
    id = useId(),
    param = `snapshot-build-key.${orgId}`;
  useEffect(() => {
    const stored = new URL(window.location.href).searchParams.get(param);
    setRequestId(stored && isUuid(stored) ? stored : crypto.randomUUID());
    const keep = (event: Event) => event.preventDefault();
    const node = form.current;
    node?.addEventListener("reset", keep);
    return () => node?.removeEventListener("reset", keep);
  }, [param]);
  useEffect(() => {
    if (!result?.ok || embedded) return;
    const url = new URL(window.location.href);
    url.searchParams.delete(param);
    url.searchParams.set("item", result.snapshotId);
    window.history.replaceState(window.history.state, "", url);

    router.refresh();
  }, [result, param, router, embedded]);
  useEffect(() => {
    if (!embedded || !result?.ok) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function follow() {
      try {
        const target = await embedded?.readDocker(result && result.ok ? result.snapshotId : "");
        if (!active || !target) {
          if (active) timer = setTimeout(follow, 2000);
          return;
        }
        if (target.building) timer = setTimeout(follow, 2000);
        else if (target.failed) {
          setEmbeddedFailed(target.reason ?? "The build did not finish.");
          embedded?.onBuilding("");
          setRequestId(crypto.randomUUID());
        }
      } catch {
        if (active) timer = setTimeout(follow, 2000);
      }
    }
    void follow();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [embedded, result]);

  useEffect(() => {
    if (embedded && result && !result.ok) embedded.onBuilding("");
  }, [embedded, result]);
  const built = result?.ok ? snapshots.find((row) => row.id === result.snapshotId) : null;
  useEffect(() => {
    if (built?.status === "failed") setRequestId(crypto.randomUUID());
  }, [built?.status]);
  const online = hosts.filter((host) => host.state === "online");
  const visibilityField = (
    <>
      <LaunchChoice
        inline
        label="Who sees it"
        value={visibility}
        onChange={setVisibility}
        options={[
          { value: "private", label: "only you" },
          {
            value: "org",
            label: "everyone in the organization",
            ...(!isAdmin ? { reason: "Only an organization admin can create a snapshot for everyone." } : {}),
          },
        ]}
      />
      <input type="hidden" name="visibility" value={visibility} />
    </>
  );
  return (
    <>
      <form
        ref={form}
        action={action}
        className="space-y-4"
        onSubmit={() => {
          const url = new URL(window.location.href);
          if (embedded) {
            setEmbeddedFailed("");
            embedded.onBuilding(buildName);
          }
          url.searchParams.set(param, requestId);
          window.history.replaceState(window.history.state, "", url);
        }}
      >
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="config" value={advanced ? config : generated} />
        <input type="hidden" name="requestId" value={requestId} />
        {!githubConnected && (
          <p role="alert" className="text-sm">
            GitHub is not connected, so Armada cannot download your repositories.{" "}
            <a href="/github/connect" target="_blank" rel="noreferrer" className="underline">
              Connect GitHub
            </a>
            . Opens in a new tab; this form keeps what you typed.
          </p>
        )}
        <fieldset
          disabled={pending || (result?.ok && built?.status !== "failed" && !embeddedFailed)}
          className="space-y-4"
        >
          <div className="text-lg leading-loose">
            Build{" "}
            <Input
              id={`${id}-name`}
              aria-label="Snapshot name"
              name="name"
              value={buildName}
              onChange={(event) => setBuildName(event.target.value)}
              required
              maxLength={80}
              placeholder="armada-warm"
              className="inline-flex h-8 w-40 border-0 border-b border-dashed rounded-none shadow-none"
              pattern={"[A-Za-z0-9][A-Za-z0-9._\\-]{0,79}"}
              title="Start with a letter or number; use only letters, numbers, dots, underscores and hyphens."
            />{" "}
            on{" "}
            {placement ? (
              <SnapshotPlacementWord />
            ) : (
              <LaunchChoice
                inline
                label="Where to build"
                value={hostId}
                onChange={setHostId}
                options={hosts.map((host) => {
                  const reason = hostBuildBlocker(host);
                  return {
                    value: host.id,
                    label: `Docker host ${host.name ?? host.id}`,
                    ...(reason === null ? {} : { reason }),
                  };
                })}
              />
            )}
            <input type="hidden" name="hostId" value={placement?.value ?? hostId} />
            {!embedded && ", visible to "}
            {!embedded && visibilityField}
          </div>
          <p className="flex gap-2 text-sm">
            <LockIcon className="size-4 shrink-0" />
            Where it is built and who sees it are permanent.
          </p>
          <SnapshotDetails openInComposer={Boolean(embedded)}>
            {embedded && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Who sees it</p>
                {visibilityField}
              </div>
            )}
            <Button type="button" variant="link" onClick={() => setAdvanced(!advanced)}>
              {advanced ? "Use repositories and commands instead" : "Use a snapshot file instead"}
            </Button>
            {advanced ? (
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-file`}>Snapshot JSON file</Label>
                <Input
                  id={`${id}-file`}
                  type="file"
                  accept=".json,application/json"
                  onChange={async (event) => {
                    const source = event.currentTarget;
                    const file = source.files?.[0];
                    setConfig("");
                    setFileError("");
                    if (!file) return;
                    try {
                      if (file.size > 1_048_576) throw new Error();
                      const parsed = parseSnapshotConfig(JSON.parse(await file.text()));
                      if (source.files?.[0] === file) setConfig(JSON.stringify(parsed));
                    } catch {
                      if (source.files?.[0] === file)
                        setFileError("Choose a snapshot JSON file under 1 MiB with repositories and init commands.");
                    }
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  The same versionable repos, branches and init configuration as Boat or Modal. Never include
                  credentials.
                </p>
              </div>
            ) : (
              <>
                <Label>Repositories to put on the machine</Label>
                {repos.map((repo, index) => (
                  <div key={repo.key} className="border-b py-2 space-y-2">
                    <div className="flex gap-2 items-center">
                      <Input
                        aria-label={`Repository ${index + 1}`}
                        value={repo.url}
                        onChange={(e) => updateRepo(index, "url", e.target.value)}
                        placeholder="owner/repo or a github.com link"
                        required
                      />
                      <span className="text-xs text-muted-foreground">{repo.branch || "Default branch"}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label={`Remove repository ${index + 1}`}
                        disabled={repos.length === 1}
                        onClick={() => setRepos((rows) => rows.filter((_, i) => i !== index))}
                      >
                        Remove
                      </Button>
                    </div>
                    <DockerRepositoryDetails embedded={Boolean(embedded)}>
                      <div className="space-y-2 py-2">
                        <Label htmlFor={`${id}-branch-${index}`}>Branch</Label>
                        <Input
                          id={`${id}-branch-${index}`}
                          value={repo.branch}
                          placeholder="Default branch"
                          onChange={(e) => updateRepo(index, "branch", e.target.value)}
                        />
                        <Label htmlFor={`${id}-dir-${index}`}>Folder on the machine</Label>
                        <div className="flex items-center gap-2 text-xs">
                          <span>/home/user/</span>
                          <Input
                            id={`${id}-dir-${index}`}
                            value={repo.dir}
                            pattern="[^/\\\\]+"
                            placeholder="repo name"
                            onChange={(e) => updateRepo(index, "dir", e.target.value)}
                          />
                        </div>
                        <Label htmlFor={`${id}-history-${index}`}>History to download</Label>
                        <NativeSelect
                          id={`${id}-history-${index}`}
                          value={repo.history}
                          onChange={(e) => updateRepo(index, "history", e.target.value)}
                        >
                          <option value="full">Everything</option>
                          <option value="shallow">Latest commit only</option>
                        </NativeSelect>
                        <p className="text-xs text-muted-foreground">
                          Armada checks downloaded GitHub, Skillpack and Armada tokens before saving. Latest commit only
                          is faster on large repositories.
                        </p>
                      </div>
                    </DockerRepositoryDetails>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  disabled={repos.length >= 16}
                  onClick={() =>
                    setRepos((rows) => [
                      ...rows,
                      { key: crypto.randomUUID(), url: "", branch: "", dir: "", history: "full" },
                    ])
                  }
                >
                  Add repository
                </Button>
                {!parsed.ok && repos.some((repo) => repo.url) && (
                  <p role="alert" className="text-sm">
                    {parsed.error}
                  </p>
                )}
              </>
            )}
          </SnapshotDetails>
          {!advanced && (
            <div className="space-y-2">
              <Label htmlFor={`${id}-commands`}>
                {embedded ? "Init commands (optional)" : "Commands to run once, while building (optional)"}
              </Label>
              <Textarea
                id={`${id}-commands`}
                value={commands}
                onChange={(e) => setCommands(e.target.value)}
                placeholder="(cd web && bun install)"
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                One per line, each starting from the home folder. At most 32 commands. Never put a password or key here;
                an agent gets secrets through a template.
              </p>
            </div>
          )}
        </fieldset>
        {(fileError || (result && !result.ok)) && (
          <p role="alert" className="text-sm text-destructive">
            {fileError || (result && !result.ok ? result.error : "")}
          </p>
        )}
        {!canBuild && (
          <p className="text-sm text-muted-foreground">
            Snapshot builds are unavailable. Enable Docker placement and update the server and host.
          </p>
        )}
        {!online.length && <p className="text-sm text-muted-foreground">Bring a registered host online to build.</p>}
        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={
              !canBuild ||
              !online.length ||
              !(advanced ? config : generated) ||
              !githubConnected ||
              !requestId ||
              pending ||
              (result?.ok && built?.status !== "failed" && !embeddedFailed)
            }
          >
            {pending ? "Starting build…" : built?.status === "failed" ? "Try again" : "Build snapshot"}
          </Button>
        </div>
        <DialogClose ref={close} className="hidden" aria-label="Close snapshot build" />
      </form>
      {result?.ok && (
        <div role="status" className="space-y-3 text-sm">
          <p>
            {embeddedFailed ||
              (built?.status === "ready"
                ? `${built.name} is ready`
                : built?.status === "failed"
                  ? `The build did not finish. ${built.failureReason ?? "Check the host before trying again."}`
                  : "Building on the Docker host… You can close this window meanwhile.")}
          </p>
          {built?.status === "ready" && launch && (
            <LaunchDialog
              {...launch}
              golden={built.name}
              provider="docker"
              snapshotId={built.id}
              repositories={built.config.repos.map((repo) => repo.dir ?? "")}
            />
          )}
        </div>
      )}
    </>
  );
}

/** A bounded metadata refresh; never resubmits a build. */
export function SnapshotBuildRefresh({ building }: { building: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [building, router]);
  return building ? (
    <p role="status" className="text-sm text-muted-foreground">
      Building on the Docker host. It continues if you close this window.
    </p>
  ) : null;
}

/** One explicit confirmation, with the same request identity kept across an uncertain response or a reopened dialog. */
export function SnapshotRebuildDialog({
  orgId,
  snapshotId,
  name,
  currentVersion,
}: {
  orgId: string;
  snapshotId: string;
  name: string;
  currentVersion: string;
}) {
  const [open, setOpen] = useState(false);
  const accepted = useCallback(() => setOpen(false), []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Rebuild</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rebuild {name}?</DialogTitle>
          <DialogDescription>
            Repositories and setup commands run again on the original host using Armada {currentVersion}. This creates a
            new snapshot entry. The old snapshot stays unchanged and available to launch.
          </DialogDescription>
        </DialogHeader>
        <SnapshotRebuildForm orgId={orgId} snapshotId={snapshotId} onAccepted={accepted} />
      </DialogContent>
    </Dialog>
  );
}

function SnapshotRebuildForm({
  orgId,
  snapshotId,
  onAccepted,
}: {
  orgId: string;
  snapshotId: string;
  onAccepted: () => void;
}) {
  const [result, action, pending] = useMutationState(rebuildDockerSnapshot);
  const [requestId, setRequestId] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const param = `snapshot-rebuild-key.${orgId}.${snapshotId}`;
  useEffect(() => {
    const stored = new URL(window.location.href).searchParams.get(param);
    setRequestId(stored && isUuid(stored) ? stored : crypto.randomUUID());
    const keep = (event: Event) => event.preventDefault();
    const node = form.current;
    node?.addEventListener("reset", keep);
    return () => node?.removeEventListener("reset", keep);
  }, [param]);
  useEffect(() => {
    if (!result?.ok) return;
    const url = new URL(window.location.href);
    url.searchParams.delete(param);
    url.searchParams.set("item", result.snapshotId);
    window.history.replaceState(window.history.state, "", url);
    onAccepted();
    router.refresh();
  }, [result, param, router, onAccepted]);
  return (
    <form
      ref={form}
      action={action}
      className="space-y-4"
      onSubmit={() => {
        const url = new URL(window.location.href);
        url.searchParams.set(param, requestId);
        window.history.replaceState(window.history.state, "", url);
      }}
    >
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="snapshotId" value={snapshotId} />
      <input type="hidden" name="requestId" value={requestId} />
      {result && !result.ok && (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={pending}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={!requestId || pending || result?.ok}>
          {pending ? "Starting rebuild…" : "Rebuild"}
        </Button>
      </div>
    </form>
  );
}
