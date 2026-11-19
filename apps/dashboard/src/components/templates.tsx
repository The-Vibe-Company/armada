"use client";

import type { Harness } from "@armada/core";
import {
  BracesIcon,
  LayoutTemplateIcon,
  LockIcon,
  LockKeyholeIcon,
  PencilIcon,
  PlugIcon,
  RocketIcon,
  Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import {
  Children,
  isValidElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { readLaunchDialogOptions } from "@/app/actions/sandboxes";
import {
  createTemplate,
  deleteTemplate,
  launchFromTemplate,
  publishTemplate,
  type TemplateLaunchResult,
} from "@/app/actions/templates";
import { SubmitButton } from "@/components/action-form";
import { CreateDialog } from "@/components/create-dialog";
import {
  ChoiceChip,
  ComposerLocation,
  ComposerStop,
  DockerLimits,
  LaunchChip,
  LaunchComposer,
} from "@/components/launch-composer";
import { DiscoveredLaunchStart } from "@/components/launch-dialog";
import { LaunchChoice, LaunchDialogContent, LaunchDialogHeader } from "@/components/launch-surface";
import { MachineSizeField } from "@/components/machine-size-field";
import type { ModelCatalog } from "@/components/model-fields";
import { SkillPicker } from "@/components/skill-picker";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { useMutationState } from "@/components/use-mutation-state";
import type { ActionResult } from "@/lib/action";
import { PROVIDER_LABELS } from "@/lib/golden-form";
import { HARNESS_LABELS } from "@/lib/labels";
import { composerChips, launchHoldIds, templateStartAfterRemoval } from "@/lib/launch-composer";
import { accountProblem, accountsFor, HARNESS_PATH, launchDefault } from "@/lib/model-accounts";
import type { TemplateLaunchTarget } from "@/lib/template-launch";
import {
  MAX_TEMPLATE_NAME,
  newRequestKey,
  type TemplateDefinition,
  type TemplateLookups,
  type TemplateScope,
  unreadableSelections,
} from "@/lib/templates";
import { cn } from "@/lib/utils";

type Action = (previous: ActionResult | null, data: FormData) => Promise<ActionResult>;

function ResultLine({ result }: { result: ActionResult | null }) {
  if (!result || result.ok) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {result.error}
    </p>
  );
}

/** A template's mark on its row. */
export function TemplateMark() {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/25 bg-primary/10 text-[var(--accent-text)] [&_svg]:size-4"
    >
      <LayoutTemplateIcon />
    </span>
  );
}

/** Where an untouched secret binding would be: said plainly, so nobody looks for it elsewhere. */
export function NoSecretsNote({ className }: { className?: string }) {
  return (
    <p
      className={cn("flex gap-2 rounded-md border border-dashed p-2.5 text-xs text-muted-foreground", className)}
      data-no-secrets
    >
      <LockKeyholeIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <span className="font-medium text-foreground">Secret values are never shown here.</span> A template delivers
        chosen secrets to the agent environment; anyone who can launch it can use those values.
      </span>
    </p>
  );
}

/**
 * React resets a form after its action returns. A refused publish or launch must keep every choice, including the
 * controlled ones (the model, the machine size) that listen for that reset: the reset is cancelled before any of
 * them hears it, so a retry sends exactly what the person saw.
 */
function useKeepOnReset(root: RefObject<HTMLFormElement | null>) {
  useEffect(() => {
    const form = root.current;
    if (!form) return;
    const keep = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    // Capture listeners on the target run before the fields' own (bubble) listeners.
    form.addEventListener("reset", keep, true);
    return () => form.removeEventListener("reset", keep, true);
  }, [root]);
}

/** The form's starting point: a revision being edited, or nothing for a new template. */
type Editing = { id: string; name: string; scope: TemplateScope; revision: number; definition: TemplateDefinition };

/**
 * The create flow (#949), the shared {@link CreateDialog}: one launch sentence followed by its optional resources. The sentence holds its name, audience, snapshot and agent; below it are optional tools, skills and variables. Who can use it cannot be changed later, so it is marked.
 */
export function CreateTemplateDialog(props: {
  orgId: string;
  orgName: string;
  isAdmin: boolean;
  lookups: TemplateLookups;
  catalog: ModelCatalog;
}) {
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
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
      label="New template"
      title="New template"
      description="A saved launch you can start in a click or run on a routine."
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setGeneration((value) => value + 1);
      }}
      triggerAttrs={{ "data-new-template": "" }}
    >
      <TemplateForm key={generation} {...props} action={createTemplate} onDone={onDone} />
    </CreateDialog>
  );
}

function TemplateForm({
  orgId,
  orgName,
  isAdmin,
  lookups,
  catalog,
  action,
  onDone,
  editing,
}: {
  orgId: string;
  orgName: string;
  isAdmin: boolean;
  lookups: TemplateLookups;
  catalog: ModelCatalog;
  action: Action;
  onDone: (message: string) => void;
  editing?: Editing;
}) {
  const [state, formAction] = useMutationState(action);
  const [name, setName] = useState(editing?.name ?? "");
  const [scope, setScope] = useState<TemplateScope>(editing?.scope ?? "personal");
  const [golden, setGolden] = useState(editing?.definition.goldenId ?? "");
  const [placement, setPlacement] = useState(
    editing?.definition.provider === "docker"
      ? `${editing.definition.hostId}:${editing.definition.snapshotId ?? ""}`
      : "",
  );
  const [harness, setHarness] = useState<Harness>(editing?.definition.harness ?? "claude");
  const [keepAccount, setKeepAccount] = useState(true);
  const [credential, setCredential] = useState("");
  const [skills, setSkills] = useState<string[]>(() => [...(editing?.definition.skills ?? [])]);
  const [problem, setProblem] = useState<string | null>(null);
  const keepingPinnedAccount = Boolean(
    keepAccount && editing?.definition.modelAccount && harness === editing.definition.harness,
  );
  const accountSelection =
    lookups.accounts?.state === "ready"
      ? launchDefault(lookups.accounts.accounts, harness, lookups.accounts.now).state
      : null;
  const root = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) onDone(state.message);
  }, [state, onDone]);
  useKeepOnReset(root);
  // A list that could not be read would silently drop what the current revision chose from it: no publication.
  const lost = editing ? unreadableSelections(editing.definition, lookups) : null;
  const environments = lookups.goldens.filter((row) => scope === "personal" || row.visibility === "org");
  const chosen = lookups.goldens.find((row) => row.id === golden);
  const goldenProblem =
    chosen && scope === "org" && chosen.visibility !== "org"
      ? `${chosen.name} is private: an organization template needs a shared snapshot.`
      : null;

  const [model, setModel] = useState(editing?.definition.model ?? catalog[harness].defaultModel);
  const [effort, setEffort] = useState(editing?.definition.reasoningEffort ?? catalog[harness].defaultReasoningEffort);
  const modelEntry = catalog[harness];
  const efforts =
    modelEntry.models.find((entry) => entry.id === model)?.reasoningEfforts ?? modelEntry.reasoningEfforts;
  const word = "inline-flex h-10 max-w-full rounded-md border bg-muted/30 px-2 align-middle text-sm sm:h-8";
  return (
    <form
      ref={root}
      action={formAction}
      className="space-y-4"
      data-template-form
      onSubmit={(event) => {
        const message = !name.trim()
          ? "Name the template."
          : !chosen && !placement
            ? "Choose a snapshot."
            : chosen && !chosen.ready
              ? "Build the snapshot first."
              : goldenProblem;
        if (message) {
          event.preventDefault();
          setProblem(message);
        }
      }}
    >
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="scope" value={scope} />
      <input type="hidden" name="placement" value={placement} />
      {placement && <input type="hidden" name="golden" value="" />}
      {editing && (
        <>
          <input type="hidden" name="id" value={editing.id} />
          <input type="hidden" name="revision" value={editing.revision} />
          <input type="hidden" name="name" value={editing.name} />
        </>
      )}
      <ResultLine result={state} />
      <div className="space-y-4 text-sm">
        <div>
          <span className="mb-2 block font-medium">Name</span>
          {editing ? (
            <strong>{editing.name}</strong>
          ) : (
            <Input
              aria-label="Template name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={MAX_TEMPLATE_NAME}
              required
              autoComplete="off"
              placeholder="review-pr"
              className="h-[38px]"
            />
          )}
          <span className="mt-4 mb-2 block font-medium">Visible to</span>
          {editing ? (
            <span>{scope === "personal" ? "only you" : `everyone in ${orgName}`}</span>
          ) : (
            <SentenceChoice
              aria-label="Who can use it"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as TemplateScope);
                setCredential("");
              }}
              className={word}
            >
              <option value="personal">only you</option>
              <option value="org" disabled={!isAdmin}>
                everyone in {orgName}
              </option>
            </SentenceChoice>
          )}
        </div>
        <p className="flex items-center gap-2 text-xs leading-normal text-foreground">
          <LockIcon className="size-3 shrink-0" aria-hidden /> The name and who can use it are permanent.
        </p>
        <div className="text-sm">
          <span className="mb-2 block font-medium">Snapshot</span>
          <SentenceChoice
            aria-label="Snapshot"
            name={placement ? undefined : "golden"}
            value={placement || golden}
            required
            className={word}
            onChange={(event) => {
              const value = event.target.value;
              if (value.includes(":")) {
                setPlacement(value);
                setGolden("");
              } else {
                setPlacement("");
                setGolden(value);
              }
            }}
          >
            <option value="">Choose a snapshot</option>
            {environments.map((row) => (
              <option key={row.id} value={row.id} disabled={!row.ready}>
                {row.name} · {PROVIDER_LABELS[row.provider]} cloud{row.ready ? "" : " (not built yet)"}
              </option>
            ))}
            {(lookups.hosts ?? []).map((host) => (
              <optgroup key={host.id} label={`Docker host ${host.name ?? "Unnamed host"}`}>
                <option value={`${host.id}:`}>Official Armada image · {host.name ?? "Unnamed host"}</option>
                {(lookups.snapshots ?? [])
                  .filter(
                    (snapshot) =>
                      snapshot.hostId === host.id &&
                      snapshot.status === "ready" &&
                      (scope === "personal" || snapshot.visibility === "org"),
                  )
                  .map((snapshot) => (
                    <option key={snapshot.id} value={`${host.id}:${snapshot.id}`}>
                      {snapshot.name} · {host.name ?? "Unnamed host"}
                    </option>
                  ))}
              </optgroup>
            ))}
          </SentenceChoice>
          {placement
            ? ", using this exact snapshot or the official image on that server."
            : ", and picks up each rebuild of it automatically."}
        </div>
        <div>
          <span className="mb-2 block font-medium">Agent</span>
          <SentenceChoice
            aria-label="Agent"
            name="harness"
            value={harness}
            className={word}
            onChange={(event) => {
              const next = event.target.value as Harness;
              setHarness(next);
              setCredential("");
              setModel(catalog[next].defaultModel);
              setEffort(catalog[next].defaultReasoningEffort);
            }}
          >
            {(Object.keys(catalog) as Harness[]).map((value) => (
              <option key={value} value={value}>
                {HARNESS_LABELS[value]}
              </option>
            ))}
          </SentenceChoice>{" "}
          <span className="mt-4 mb-2 block font-medium">Model</span>
          <SentenceChoice
            aria-label="Model"
            name="model"
            value={modelEntry.models.some((entry) => entry.id === model) ? model : "other"}
            className={word}
            onChange={(event) => {
              setModel(event.target.value === "other" ? "" : event.target.value);
              setEffort(modelEntry.defaultReasoningEffort);
            }}
          >
            {modelEntry.models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
            <option value="other">Other model id</option>
          </SentenceChoice>
          {!modelEntry.models.some((entry) => entry.id === model) && (
            <Input
              aria-label="Other model id"
              name="other_model"
              required
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="mt-2"
            />
          )}
          <span className="mt-4 mb-2 block font-medium">Reasoning effort</span>
          <SentenceChoice
            aria-label="Reasoning effort"
            name="reasoning_effort"
            value={effort}
            className={word}
            onChange={(event) => setEffort(event.target.value)}
          >
            {efforts.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </SentenceChoice>
          <span className="mt-4 mb-2 block font-medium">Model account</span>
          {keepingPinnedAccount ? (
            <span>its pinned account</span>
          ) : (
            <SentenceChoice
              aria-label="Model account"
              name="credential"
              value={credential}
              className={word}
              onChange={(event) => setCredential(event.target.value)}
            >
              <option value="">each person's own account</option>
              {lookups.accounts?.state === "ready" &&
                accountsFor(lookups.accounts.accounts, harness)
                  .filter((account) => scope === "personal" || account.scope === "org")
                  .map((account) => (
                    <option
                      key={account.id}
                      value={account.id}
                      disabled={
                        accountProblem(account, lookups.accounts?.state === "ready" ? lookups.accounts.now : 0) !== null
                      }
                    >
                      {account.name}
                    </option>
                  ))}
            </SentenceChoice>
          )}
        </div>
        {goldenProblem && (
          <p role="alert" className="text-sm text-destructive">
            {goldenProblem}
          </p>
        )}
        {!environments.some((row) => row.ready) && !lookups.hosts?.length && (
          <p className="text-sm">
            A template starts from a snapshot, and none is built yet.{" "}
            <Link href="/snapshots" className="underline">
              New snapshot
            </Link>
          </p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Account is the subscription or API key that pays for the model. Naming one pins its version: after
          reconnecting or replacing it, save a new version of this template. Organization templates can only name
          organization accounts.
        </p>
        {lookups.accounts?.state === "unavailable" && (
          <p role="status" className="text-sm text-warning">
            Model accounts could not be loaded. Refresh to choose one.
          </p>
        )}
        {!keepingPinnedAccount && !credential && accountSelection && accountSelection !== "resolved" && (
          <p role="status" className="text-sm text-warning">
            No unambiguous usable account is available.{" "}
            <Link href={HARNESS_PATH} className="underline">
              Add or select an account in Models
            </Link>{" "}
            before launching.
          </p>
        )}
        {editing?.definition.modelAccount && harness === editing.definition.harness && (
          <Label className="flex items-center gap-2 text-sm">
            <Checkbox
              name="keep_account"
              value="on"
              checked={keepAccount}
              onCheckedChange={(value) => setKeepAccount(value === true)}
            />
            Keep its pinned model account
          </Label>
        )}
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
      </div>
      <div className="space-y-4 border-t pt-4">
        <h3 className="text-sm font-medium">What the agent gets</h3>
        <PickList
          legend="Tools"
          name="connections"
          icon={<PlugIcon />}
          empty={
            lookups.connections === null ? (
              "Tools could not be read. Refresh to choose them."
            ) : (
              <>
                No {scope === "org" ? "organization " : ""}tools yet.{" "}
                <Link className="underline underline-offset-4" href="/tools">
                  Add one in Tools
                </Link>
                .
              </>
            )
          }
          options={(lookups.connections ?? [])
            .filter((row) => scope === "personal" || row.scope === "org")
            .map((row) => ({
              id: row.id,
              label: row.name,
              note:
                row.status === "connected" ? (
                  row.scope === "org" ? (
                    "Org"
                  ) : (
                    "Personal"
                  )
                ) : (
                  <>
                    Not connected ·{" "}
                    <Link href="/tools" className="underline" target="_blank" rel="noopener noreferrer">
                      Connect
                    </Link>
                  </>
                ),
              disabled: row.status !== "connected",
            }))}
          initial={editing?.definition.connections ?? []}
        />
        <PickList
          legend="Variables"
          name="variables"
          icon={<BracesIcon />}
          mono
          empty={
            lookups.variables === null ? (
              "Variables could not be read. Refresh to choose them."
            ) : (
              <>
                No {scope === "org" ? "organization " : ""}variables yet.{" "}
                <Link className="underline underline-offset-4" href="/variables">
                  Add one in Variables
                </Link>
                .
              </>
            )
          }
          options={(lookups.variables ?? [])
            .filter((row) => row.status === "active" && (scope === "personal" || row.scope === "org"))
            .map((row) => {
              // A binding under another key than the variable's name keeps that key: say which.
              const keys = (editing?.definition.variables ?? [])
                .filter((binding) => binding.variableId === row.id)
                .map((binding) => binding.key);
              const scopeLabel = row.scope === "org" ? "Org" : "Personal";
              const aliased = keys.length > 1 || (keys.length === 1 && keys[0] !== row.name);
              return { id: row.id, label: row.name, note: aliased ? `as ${keys.join(", ")}` : scopeLabel };
            })}
          initial={editing?.definition.variables.map((binding) => binding.variableId) ?? []}
          hint="Non-secret values such as SENTRY_ORG. Anyone in the sandbox can read them."
        />
        <PickList
          legend="Secrets"
          name="secrets"
          icon={<LockKeyholeIcon />}
          mono
          empty={
            lookups.secrets == null
              ? "Secrets could not be read. Refresh to choose them."
              : "No secrets yet. Add one in Secrets."
          }
          options={[
            ...(lookups.secrets ?? [])
              .filter(
                (row) =>
                  (row.status === "active" || editing?.definition.secrets?.some((b) => b.secretId === row.id)) &&
                  (scope === "personal" || row.scope === "org"),
              )
              .map((row) => ({
                id: row.id,
                label: row.name,
                note:
                  row.status !== "active"
                    ? "Unavailable — remove to publish"
                    : row.scope === "org"
                      ? "Org"
                      : "Personal",
              })),
            ...(editing?.definition.secrets ?? [])
              .filter(
                (b, i, all) =>
                  all.findIndex((v) => v.secretId === b.secretId) === i &&
                  !lookups.secrets?.some((row) => row.id === b.secretId),
              )
              .map((b) => ({ id: b.secretId, label: b.key, note: "Unavailable — remove to publish" })),
          ]}
          initial={editing?.definition.secrets?.map((b) => b.secretId) ?? []}
          hint="API keys and passwords. Stored encrypted."
        />
        <SkillPicker orgId={orgId} value={skills} onChange={setSkills} />
        {lost && (
          <p role="alert" className="text-sm text-destructive" data-template-lost>
            {lost}
          </p>
        )}
        <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Task, folder, machine size and duration are chosen at each launch.
          </p>
          <SubmitButton data-template-publish {...(lost ? { disabled: true } : {})}>
            {editing ? `Save as version ${editing.revision + 1}` : "Save template"}
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}

/** A list of checkboxes the form sends under `name`; it scrolls inside itself when long. */
function PickList({
  legend,
  name,
  icon,
  options,
  initial,
  empty,
  hint,
  mono,
}: {
  legend: string;
  name: string;
  icon: ReactNode;
  options: { id: string; label: string; note: ReactNode; disabled?: boolean }[];
  initial: readonly string[];
  empty: ReactNode;
  hint?: string;
  mono?: boolean;
}) {
  const pickerId = useId();
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(initial));
  const count = options.filter((option) => checked.has(option.id) && !option.disabled).length;
  return (
    <fieldset className="space-y-2" data-pick={name}>
      <legend className="flex w-full items-center justify-between text-sm font-medium">
        {legend}
        <span className="text-xs font-normal text-muted-foreground tabular-nums">
          {count > 0 ? `${count} chosen` : "None"}
        </span>
      </legend>
      {options.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="max-h-40 divide-y overflow-y-auto overscroll-contain rounded-md border">
          {options.map((option) => (
            <li key={option.id}>
              <Label
                htmlFor={`${pickerId}-${option.id}`}
                className={cn(
                  "flex cursor-pointer items-center gap-3 px-3 py-2 text-sm has-[:focus-visible]:bg-accent/60 hover:bg-accent/50",
                  option.disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
                )}
              >
                <Checkbox
                  id={`${pickerId}-${option.id}`}
                  name={name}
                  value={option.id}
                  checked={checked.has(option.id) && !option.disabled}
                  disabled={option.disabled}
                  onCheckedChange={(value) => {
                    const nextSet = new Set(checked);
                    if (value === true) nextSet.add(option.id);
                    else nextSet.delete(option.id);
                    setChecked(nextSet);
                  }}
                />
                <span className="text-muted-foreground [&_svg]:size-4" aria-hidden>
                  {icon}
                </span>
                <span className={cn("min-w-0 flex-1 truncate", mono && "font-mono text-xs")}>{option.label}</span>
                <span className={cn("shrink-0 text-xs", option.disabled ? "text-warning" : "text-muted-foreground")}>
                  {option.note}
                </span>
              </Label>
            </li>
          ))}
        </ul>
      )}
      {hint && options.length > 0 && <p className="text-xs text-muted-foreground">{hint}</p>}
    </fieldset>
  );
}

/**
 * A launch from one template revision. Everything the template chose is shown, not editable; only the task, the
 * project, the machine size and how long it runs can change. One request key per opening: a retry after a lost
 * answer returns that launch instead of starting another, and a definite refusal takes a fresh key.
 */
export function TemplateLaunchForm({
  target,
  task,
  onTask,
  onRemove,
  loadingError,
  idleDelaySeconds,
  dockerLimits,
  repositoryFolder,
}: {
  target: TemplateLaunchTarget;
  task: string;
  onTask: (task: string) => void;
  onRemove: () => void;
  loadingError?: string;
  idleDelaySeconds?: number | undefined;
  dockerLimits?: ReactNode;
  repositoryFolder?: string | undefined;
}) {
  const id = useId();
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const run = useCallback(async (previous: TemplateLaunchResult | null, data: FormData) => {
    const result = await launchFromTemplate(previous, data);
    if (!result.ok && !result.pending) setRequestKey(newRequestKey());
    return result;
  }, []);
  const [state, formAction] = useMutationState(run);
  const [manualProject, setProject] = useState(target.repositories.length === 1 ? (target.repositories[0] ?? "") : "");
  const project = repositoryFolder ?? manualProject;
  const root = useRef<HTMLFormElement>(null);
  useKeepOnReset(root);
  const error = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state && !state.ok) error.current?.focus();
  }, [state]);
  const accountList = target.accounts;
  const eligible =
    accountList?.state === "ready"
      ? accountsFor(accountList.accounts, target.definition.harness).filter(
          (account) => accountProblem(account, accountList.now) === null,
        )
      : [];
  const defaultAccount =
    accountList?.state === "ready"
      ? launchDefault(accountList.accounts, target.definition.harness, accountList.now)
      : null;
  const preset =
    defaultAccount?.state === "resolved" ? `${defaultAccount.account.id}:${defaultAccount.account.version}` : "";

  const [account, setAccount] = useState(preset);
  const named = target.definition.modelAccount;
  const chosen = eligible.find((row) => `${row.id}:${row.version}` === account);
  const namedLabel =
    accountList?.state === "ready"
      ? (accountList.accounts.find((row) => row.id === named?.id)?.name ?? "Unavailable account")
      : "Unavailable account";
  const accountHold = !named && eligible.length > 0 && !chosen;
  const holds = launchHoldIds(id, { account: accountHold, template: Boolean(target.blocker) });
  const { provider } = target.definition;
  const chips = composerChips(provider, target.repositories.length, Boolean(target.sizing), true);
  const name = target.goldenName ?? "Unavailable snapshot";
  const pill = (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="max-w-full rounded-full"
      onClick={onRemove}
      aria-label={`${target.name}, remove template`}
    >
      <span className="truncate">{target.name}</span> <span aria-hidden="true">×</span>
    </Button>
  );

  return (
    <form ref={root} action={formAction} data-template-launch={target.name}>
      <input type="hidden" name="org" value={target.orgId} />
      <input type="hidden" name="id" value={target.id} />
      <input type="hidden" name="revision" value={target.revision} />
      <input type="hidden" name="request_key" value={requestKey} />
      {provider !== "docker" && <input type="hidden" name="repo" value={project} />}
      {!named && eligible.length > 0 && <input type="hidden" name="model_account" value={chosen ? account : ""} />}
      <LaunchComposer
        id={id}
        headline={`What should we build ${chips.docker ? "on" : "in"} ${chips.docker ? (target.hostName ?? name) : project || name}?`}
        template={target.name}
        templatePill={pill}
        docker={chips.docker}
        loadingError={loadingError}
        task={task}
        onTask={onTask}
        holds={holds}
        tools={
          <LaunchChip label={`Tools · ${target.tools.length}`} locked title="Tools">
            <p className="p-2 text-sm">{target.tools.join(", ") || "None"}</p>
          </LaunchChip>
        }
        skills={
          <LaunchChip label={`Skills · ${target.definition.skills.length}`} locked title="Skills">
            <p className="p-2 text-sm">{target.definition.skills.join(", ") || "None"}</p>
          </LaunchChip>
        }
        agent={
          <LaunchChip label={target.agent} title="Agent, model and effort" locked>
            <div className="space-y-2 p-2 text-sm">
              <p>{target.agent}</p>
              {named && <p>Account · {namedLabel}</p>}
              <p>Agent, model and effort come from the template.</p>
            </div>
          </LaunchChip>
        }
        alerts={
          <>
            {accountHold && (
              <p id={`${id}-account-unavailable`} role="alert" tabIndex={-1} className="text-sm text-warning">
                Choose an account.
              </p>
            )}
            {target.blocker && (
              <p id={`${id}-blocked`} role="alert" tabIndex={-1} className="text-sm text-warning">
                {target.blocker}
              </p>
            )}
            {state && !state.ok && (
              <p
                ref={error}
                role="alert"
                tabIndex={-1}
                className={cn("text-sm", state.pending ? "text-warning" : "text-destructive")}
              >
                {state.error}{" "}
                {state.pending && (
                  <Link className="underline underline-offset-4" href="/sandboxes">
                    Open Sandboxes
                  </Link>
                )}
              </p>
            )}
          </>
        }
        location={
          <>
            <ComposerLocation
              locked
              name={name}
              folder={chips.folder}
              repositories={target.repositories}
              project={project}
              onProject={setProject}
            />
            {provider !== "docker" && chips.machine && target.sizing && (
              <MachineSizeField provider={provider} policy={target.sizing.policy} repositoryDir={project} />
            )}
            {!named && (
              <ChoiceChip
                title="Account"
                label={`Account · ${chosen?.name ?? "Choose an account"}`}
                value={account}
                options={eligible.map((row) => ({
                  value: `${row.id}:${row.version}`,
                  label: row.name,
                  group: row.scope === "org" ? "Organization" : "Personal",
                }))}
                onChange={setAccount}
              >
                <p className="border-t p-2 text-sm text-muted-foreground">
                  Choose another account if a subscription is busy.{" "}
                  <Link className="underline" href={HARNESS_PATH}>
                    Manage model accounts
                  </Link>
                </p>
              </ChoiceChip>
            )}
          </>
        }
        options={
          <>
            <ComposerStop provider={provider} idleDelaySeconds={idleDelaySeconds} />
            {chips.docker && <DockerLimits details={dockerLimits} />}
          </>
        }
      />
    </form>
  );
}

/** The Launch button of a template's row and panel. */
export function TemplateLaunchDialog({
  target,
  size = "sm",
  dockerLimits,
}: {
  target: TemplateLaunchTarget;
  size?: "sm" | "default";
  dockerLimits?: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size={size} aria-label={`Launch from ${target.name}`} data-launch-template={target.name}>
          <RocketIcon /> Launch
        </Button>
      </DialogTrigger>
      <LaunchDialogContent>
        <DirectTemplateLaunchStart target={target} dockerLimits={dockerLimits} />
      </LaunchDialogContent>
    </Dialog>
  );
}

function DirectTemplateLaunchStart({
  target,
  dockerLimits,
}: {
  target: TemplateLaunchTarget;
  dockerLimits?: ReactNode;
}) {
  const [task, setTask] = useState("");
  const [options, setOptions] = useState<Awaited<ReturnType<typeof readLaunchDialogOptions>> | null>(null);
  const [remove, setRemove] = useState(false);
  const [error, setError] = useState("");
  const [request, setRequest] = useState({ retry: false });
  useEffect(() => {
    let active = true;
    void readLaunchDialogOptions()
      .then((next) => {
        if (!active) return;
        if (next.orgId !== target.orgId) {
          setError("Switch to this organization before launching.");
        } else {
          setOptions(next);
        }
      })
      .catch(() => {
        if (active)
          setError(
            request.retry
              ? "Starting points could not be reloaded. Close and reopen to try again."
              : "Other snapshots and Docker hosts could not be loaded. Close and reopen to try again.",
          );
      });
    return () => {
      active = false;
    };
  }, [target.orgId, request]);

  if (options) {
    const start = templateStartAfterRemoval(target, options.targets);
    const starts = options.targets.includes(start) ? options.targets : [start, ...options.targets];
    return (
      <DiscoveredLaunchStart
        target={start}
        options={{ ...options, targets: starts }}
        initialTask={task}
        initialTemplate={remove ? undefined : target}
        dockerLimits={dockerLimits}
      />
    );
  }
  if (!error) return <LaunchDialogHeader title={`Launch from ${target.name}`} description="Loading starting points…" />;
  return (
    <TemplateLaunchForm
      target={target}
      task={task}
      onTask={setTask}
      onRemove={() => {
        setRemove(true);
        setError("");
        setRequest({ retry: true });
      }}
      loadingError={error}
      dockerLimits={dockerLimits}
    />
  );
}

/**
 * The panel's management: publish a new revision (the same form, started from the current one) or delete. A
 * member who does not manage the template reads the same facts without the controls.
 */
export function TemplateManage({
  editing,
  orgId,
  orgName,
  lookups,
  catalog,
}: {
  editing: Editing;
  orgId: string;
  orgName: string;
  lookups: TemplateLookups;
  catalog: ModelCatalog;
}) {
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const toast = useToast();
  const onDone = useCallback(
    (message: string) => {
      toast({ tone: "success", title: message });
      setDialog(null);
    },
    [toast],
  );
  const run = useCallback(
    async (previous: ActionResult | null, data: FormData) => {
      const result = await deleteTemplate(previous, data);
      if (result.ok) onDone(result.message);
      return result;
    },
    [onDone],
  );
  const [deleted, deleteAction] = useMutationState(run);
  return (
    <div className="flex flex-wrap gap-2 border-t pt-4">
      <Button variant="outline" size="sm" onClick={() => setDialog("edit")} data-edit-template>
        <PencilIcon /> Change
      </Button>
      <Button variant="destructive-outline" size="sm" onClick={() => setDialog("delete")}>
        <Trash2Icon /> Remove
      </Button>
      <Dialog open={dialog === "edit"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Change {editing.name}</DialogTitle>
            <DialogDescription>
              Saving creates version {editing.revision + 1}. New launches use it; version {editing.revision} stays as it
              was, and routines keep the version they were set up with.
            </DialogDescription>
          </DialogHeader>
          {dialog === "edit" && (
            <TemplateForm
              orgId={orgId}
              orgName={orgName}
              isAdmin
              lookups={lookups}
              catalog={catalog}
              action={publishTemplate}
              onDone={onDone}
              editing={editing}
            />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog open={dialog === "delete"} onOpenChange={(open) => !open && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {editing.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Nobody can launch from it any more, and routines using it will fail. Sandboxes already launched from it
              keep running. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ResultLine result={deleted} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <form action={deleteAction}>
              <input type="hidden" name="org" value={orgId} />
              <input type="hidden" name="id" value={editing.id} />
              <input type="hidden" name="revision" value={editing.revision} />
              <input type="hidden" name="name" value={editing.name} />
              <SubmitButton variant="destructive">Remove template</SubmitButton>
            </form>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SentenceChoice({
  children,
  value,
  name,
  onChange,
  "aria-label": label,
}: {
  children: ReactNode;
  value: string;
  name?: string | undefined;
  onChange: (event: { target: { value: string } }) => void;
  "aria-label": string;
  className?: string;
  required?: boolean;
}) {
  const options: { value: string; label: string; group?: string; reason?: string }[] = [];
  function collect(nodes: ReactNode, group?: string) {
    Children.forEach(nodes, (child) => {
      if (!isValidElement<{ children?: ReactNode; value?: string; label?: string; disabled?: boolean }>(child)) return;
      if (child.type === "optgroup") collect(child.props.children, child.props.label);
      else if (child.type === "option")
        options.push({
          value: child.props.value ?? "",
          label: Children.toArray(child.props.children).join(""),
          ...(group ? { group } : {}),
          ...(child.props.disabled ? { reason: "Not available" } : {}),
        });
    });
  }
  collect(children);
  return (
    <>
      <LaunchChoice
        presentation={label === "Model account" ? "picker" : "chips"}
        inline
        label={label}
        value={value}
        options={options}
        onChange={(next) => onChange({ target: { value: next } })}
      />
      {name && <input type="hidden" name={name} value={value} />}
    </>
  );
}
