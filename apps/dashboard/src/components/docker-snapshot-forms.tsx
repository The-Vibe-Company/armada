"use client";

import { parseGoldenConfig } from "@armada/core";
import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useEffect, useId, useRef, useState } from "react";
import { buildDockerSnapshot } from "@/app/actions/docker-snapshots";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { isUuid } from "@/lib/action";
import type { DockerHost } from "@/lib/docker-hosts";

/** One create dialog, with the same provider choice for cloud and host-local snapshots. */
export function SnapshotCreateChoice({
  cloudForms,
  hosts,
  orgId,
  isAdmin,
  canBuild,
}: {
  cloudForms: Partial<Record<"boat" | "modal", ReactNode>>;
  hosts: DockerHost[];
  orgId: string;
  isAdmin: boolean;
  canBuild: boolean;
}) {
  const cloud = Object.keys(cloudForms) as ("boat" | "modal")[];
  const [provider, setProvider] = useState<string>(cloud[0] ?? "docker");
  const id = useId();
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={id}>Build on</Label>
        <NativeSelect id={id} value={provider} onChange={(event) => setProvider(event.target.value)}>
          {cloud.map((value) => (
            <option key={value} value={value}>
              {value === "boat" ? "Boat" : "Modal"}
            </option>
          ))}
          {hosts.length > 0 && <option value="docker">Your host · Docker</option>}
        </NativeSelect>
      </div>
      {provider === "docker" ? (
        <DockerSnapshotForm hosts={hosts} orgId={orgId} isAdmin={isAdmin} canBuild={canBuild} />
      ) : (
        cloudForms[provider as "boat" | "modal"]
      )}
    </div>
  );
}

function DockerSnapshotForm({
  hosts,
  orgId,
  isAdmin,
  canBuild,
}: {
  hosts: DockerHost[];
  orgId: string;
  isAdmin: boolean;
  canBuild: boolean;
}) {
  const [result, action, pending] = useActionState(buildDockerSnapshot, null);
  const [config, setConfig] = useState("");
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
    if (!result?.ok) return;
    const url = new URL(window.location.href);
    url.searchParams.delete(param);
    url.searchParams.set("item", result.snapshotId);
    window.history.replaceState(window.history.state, "", url);
    close.current?.click();
    router.refresh();
  }, [result, param, router]);
  const online = hosts.filter((host) => host.state === "online");
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
      <input type="hidden" name="config" value={config} />
      <input type="hidden" name="requestId" value={requestId} />
      <fieldset disabled={pending || result?.ok} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            name="name"
            required
            maxLength={80}
            placeholder="my-project"
            pattern={"[A-Za-z0-9][A-Za-z0-9._\\-]{0,79}"}
            title="Start with a letter or number; use only letters, numbers, dots, underscores and hyphens."
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-host`}>Host</Label>
          <NativeSelect id={`${id}-host`} name="hostId" required defaultValue={online[0]?.id ?? ""}>
            <option value="" disabled>
              Choose an online host
            </option>
            {hosts.map((host) => (
              <option key={host.id} value={host.id} disabled={host.state !== "online"}>
                {host.name ?? host.id} · {host.state}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-file`}>Golden JSON file</Label>
          <Input
            id={`${id}-file`}
            type="file"
            accept=".json,application/json"
            required
            onChange={async (event) => {
              const source = event.currentTarget;
              const file = source.files?.[0];
              setConfig("");
              setFileError("");
              if (!file) return;
              try {
                if (file.size > 1_048_576) throw new Error();
                const parsed = parseGoldenConfig(JSON.parse(await file.text()));
                if (source.files?.[0] === file) setConfig(JSON.stringify(parsed));
              } catch {
                if (source.files?.[0] === file)
                  setFileError("Choose a golden JSON file under 1 MiB with repositories and init commands.");
              }
            }}
          />
          <p className="text-xs text-muted-foreground">
            The same versionable repos, branches and init configuration as Boat or Modal. Never include credentials.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-visibility`}>Visibility</Label>
          <NativeSelect id={`${id}-visibility`} name="visibility" defaultValue="private">
            <option value="private">Private · only you</option>
            {isAdmin && <option value="org">Organization · all members</option>}
          </NativeSelect>
        </div>
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
        <Button type="submit" disabled={!canBuild || !online.length || !config || !requestId || pending || result?.ok}>
          {pending ? "Starting build…" : "Build snapshot"}
        </Button>
      </div>
      <DialogClose ref={close} className="hidden" aria-label="Close snapshot build" />
    </form>
  );
}

/** A bounded metadata refresh; never resubmits a build. */
export function SnapshotBuildRefresh({ building }: { building: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!building) return;
    const end = Date.now() + 120_000;
    const timer = setInterval(() => {
      if (Date.now() >= end) clearInterval(timer);
      else if (document.visibilityState === "visible") router.refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [building, router]);
  return building ? (
    <p role="status" className="text-sm text-muted-foreground">
      Building on your host. This list checks progress for two minutes; refresh to check again later.
    </p>
  ) : null;
}
