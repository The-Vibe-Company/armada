"use client";

import type { GitHubReposRequest, GitHubReposResponse } from "@armada/core/contract";
import { CheckIcon, FolderGit2Icon, LockIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  buildGitHubRepoPickerView,
  buildGitHubReposRequest,
  classifyGitHubReposFailure,
  type GitHubReposFailureKind,
  type GitHubReposLoadResult,
  repoKey,
  selectedRepoKeys,
} from "@/lib/github-repos";
import { listGitHubRepos } from "@/lib/github-repos-action";
import { cn } from "@/lib/utils";

type PickerState = {
  status: "idle" | "loading" | "ready" | "error";
  data: GitHubReposResponse | null;
  loadedOrg: string;
  loadedQuery: string;
  failure?: GitHubReposFailureKind;
  message?: string;
};
type PickerProps = {
  open: boolean;
  selected: readonly string[];
  maxSelected?: number;
  githubConnected?: boolean;
  allowEmptySelection?: boolean;
  snapshotChoices?: readonly (readonly [string, number])[];
  onSelect: (fullName: string) => void;
  onDone?: () => void;
  loader?: (input?: GitHubReposRequest) => Promise<GitHubReposLoadResult>;
};
const EMPTY: readonly (readonly [string, number])[] = [];
const BASE: PickerState = { status: "idle", data: null, loadedOrg: "all", loadedQuery: "" };
const OFF_MSG = "GitHub is not connected. Connect GitHub in Settings or type owner/repo.";
const EMPTY_MSG = "No repositories found. Type owner/repo or manage orgs in Settings.";
const OFF: PickerState = { ...BASE, status: "error", failure: "disconnected", message: OFF_MSG };
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const CTRL = `${FOCUS} pointer-coarse:min-h-11`;
const C = {
  pill: `inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs ${CTRL}`,
  link: `rounded-sm text-muted-foreground underline hover:text-foreground ${FOCUS}`,
  retry: `rounded border px-2 py-0.5 hover:bg-accent ${CTRL}`,
  done: `rounded bg-secondary px-2 py-0.5 font-medium ${CTRL}`,
  ref: `inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-50 pointer-coarse:min-w-11 ${CTRL}`,
  pop: "max-h-[var(--radix-popover-content-available-height)] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-xl p-2",
  err: "flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-2.5 py-2 text-xs",
  note: "px-2 text-xs text-muted-foreground",
  msg: "px-3 py-4 text-xs text-muted-foreground",
  dim: "shrink-0 text-xs text-muted-foreground",
  lock: "size-3 shrink-0 text-muted-foreground",
};
const DROP = new Set<GitHubReposFailureKind>(["disconnected", "revoked", "unauthorized"]);

export function GitHubRepoPickerContent(p: PickerProps) {
  const connected = p.githubConnected ?? true;
  const choices = p.snapshotChoices ?? EMPTY;
  const loader = p.loader ?? listGitHubRepos;
  const [query, setQuery] = useState("");
  const [org, setOrg] = useState("all");
  const [state, setState] = useState<PickerState>(() => (connected ? BASE : OFF));
  const reqRef = useRef(0);
  const attempted = useRef(false);
  const lastReq = useRef<GitHubReposRequest>({});
  const load = useCallback(
    async (input?: GitHubReposRequest) => {
      const req = input ?? {};
      const id = ++reqRef.current;
      attempted.current = true;
      lastReq.current = req;
      setState((s) => ({ status: "loading", data: s.data, loadedOrg: s.loadedOrg, loadedQuery: s.loadedQuery }));
      const res = await loader(req).catch(() => classifyGitHubReposFailure(503, "unavailable"));
      if (id !== reqRef.current) return;
      if (res.ok) {
        setState({ status: "ready", data: res.data, loadedOrg: req.account ?? "all", loadedQuery: req.query ?? "" });
        return;
      }
      setState((s) => ({
        ...(DROP.has(res.kind) ? BASE : s),
        status: "error",
        failure: res.kind,
        message: res.message,
      }));
    },
    [loader],
  );
  useEffect(() => {
    if (!connected) {
      reqRef.current += 1;
      attempted.current = false;
      lastReq.current = {};
      setState(OFF);
    }
    if (!p.open) setQuery("");
    else if (connected && !attempted.current) void load();
  }, [p.open, connected, load]);
  useEffect(() => {
    if (!p.open || !connected || !state.data) return;
    const q = query.trim();
    if ((!state.data.truncated && !state.loadedQuery) || q === (lastReq.current.query ?? "")) return;
    const timer = setTimeout(() => void load(buildGitHubReposRequest(org, q)), 250);
    return () => clearTimeout(timer);
  }, [p.open, connected, state.data, state.loadedQuery, org, query, load]);
  useEffect(() => {
    return () => {
      reqRef.current += 1;
    };
  }, []);
  const keys = useMemo(() => selectedRepoKeys(p.selected), [p.selected]);
  const view = useMemo(
    () => buildGitHubRepoPickerView(state.data, choices, org, query, state.loadedOrg, state.loadedQuery),
    [state.data, choices, org, query, state.loadedOrg, state.loadedQuery],
  );
  const { manualRepo } = view;
  const atLimit = p.maxSelected !== undefined && keys.size >= p.maxSelected;
  const chooseOrg = (next: string) => {
    setOrg(next);
    if (!state.data) return;
    const inFlight = state.status === "loading" && repoKey(lastReq.current.account ?? "all") !== repoKey(next);
    const stale = (state.loadedOrg !== "all" && repoKey(next) !== repoKey(state.loadedOrg)) || inFlight;
    const refetch =
      state.status === "error" || (state.data.truncated && next !== "all") || stale || !!state.loadedQuery;
    if (refetch) void load(buildGitHubReposRequest(next, state.data.truncated || state.loadedQuery ? query : ""));
  };
  const reload = () => void load(lastReq.current);
  const loading = state.status === "loading";
  const isConnErr = state.status === "error" && (state.failure === "disconnected" || state.failure === "revoked");
  const manualOff = atLimit && manualRepo !== null && !keys.has(repoKey(manualRepo));
  const spin = cn("size-3", loading && "animate-spin motion-reduce:animate-none");
  const linkLabel = isConnErr ? "Connect GitHub in Settings" : "Connect another GitHub org";
  return (
    <div className="space-y-1.5">
      {view.pills.length > 0 && (
        <fieldset aria-label="Filter by GitHub organization" className="flex flex-wrap gap-1 border-b px-2 pb-2 pt-1">
          {view.pills.map((pill) => {
            const on = repoKey(view.activeOrg) === repoKey(pill.key);
            const cls = cn(C.pill, on ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-accent");
            const pick = () => chooseOrg(pill.key);
            return (
              <button key={pill.key} type="button" aria-pressed={on} className={cls} onClick={pick}>
                <span className="truncate">{pill.label}</span>
                {pill.count !== undefined && <span className="opacity-70">({pill.count})</span>}
              </button>
            );
          })}
        </fieldset>
      )}
      <Command shouldFilter={false} label="GitHub repositories">
        <CommandInput placeholder="Search repos or type owner/repo" value={query} onValueChange={setQuery} />
        <CommandList className="max-h-64 overscroll-contain">
          {p.allowEmptySelection && !query.trim() && (
            <CommandItem value="none" onSelect={() => p.onSelect("")}>
              <span className="flex-1">No repository</span>
              {keys.size === 0 && <CheckIcon aria-hidden className="size-3.5" />}
            </CommandItem>
          )}
          {loading && (
            <p role="status" className={C.msg}>
              Loading GitHub repositories…
            </p>
          )}
          {view.groups.map((g) => (
            <CommandGroup key={g.key} heading={g.heading}>
              {g.items.map((item) => {
                const on = keys.has(repoKey(item.fullName));
                const off = atLimit && !on;
                const pick = () => !off && p.onSelect(item.fullName);
                return (
                  <CommandItem key={item.id} value={item.id} disabled={off} onSelect={pick}>
                    <span className="flex-1 truncate font-mono text-xs font-medium">{item.fullName}</span>
                    {item.isPrivate && <LockIcon aria-label="Private" className={C.lock} />}
                    {item.archived && <span className="text-[10px] text-muted-foreground">Archived</span>}
                    {(item.readyCount ?? 0) > 0 && <span className={C.dim}>{item.readyCount} ready</span>}
                    {on && <CheckIcon aria-label="Selected" className="size-3.5 shrink-0" />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
          {view.showManual && manualRepo && (
            <CommandItem value={`m:${manualRepo}`} disabled={manualOff} onSelect={() => p.onSelect(manualRepo)}>
              <PlusIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="flex-1 break-all">
                Use <span className="font-mono text-xs">{manualRepo}</span>
              </span>
            </CommandItem>
          )}
          {state.status === "ready" && !view.hasItems && <p className={cn(C.msg, "text-center")}>{EMPTY_MSG}</p>}
        </CommandList>
      </Command>
      {state.status === "error" && (
        <div role={isConnErr ? "status" : "alert"} className={C.err}>
          <p className={isConnErr ? "text-muted-foreground" : "text-destructive"}>{state.message}</p>
          <button type="button" onClick={reload} className={C.retry}>
            Try again
          </button>
        </div>
      )}
      {query.trim() && !manualRepo && !view.hasItems && <p className={C.note}>Enter a repository as owner/repo.</p>}
      {state.data?.truncated && (
        <p className={C.note}>Showing first {state.data.repositories.length} repos. Filter by org or search.</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-2 pt-2 text-xs">
        <Link href="/settings" className={C.link}>
          {linkLabel}
        </Link>
        <div className="flex items-center gap-1.5">
          {p.maxSelected !== undefined && (
            <span className="text-muted-foreground">
              {keys.size}/{p.maxSelected}
            </span>
          )}
          <button type="button" aria-label="Refresh repositories" disabled={loading} onClick={reload} className={C.ref}>
            <RefreshCwIcon aria-hidden className={spin} />
          </button>
          {p.onDone && (
            <button type="button" onClick={p.onDone} className={C.done}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function GitHubRepoPickerButton(
  props: Omit<PickerProps, "open" | "onDone" | "allowEmptySelection" | "snapshotChoices"> & { disabled?: boolean },
) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={props.disabled}>
          <FolderGit2Icon aria-hidden className="size-3.5" /> Browse GitHub
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Browse GitHub repositories" className={C.pop}>
        <GitHubRepoPickerContent {...props} open={open} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
