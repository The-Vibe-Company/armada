"use client";

import type { Harness } from "@armada/core";
import {
  ArrowLeftIcon,
  BracesIcon,
  CpuIcon,
  LayersIcon,
  LayoutTemplateIcon,
  LockIcon,
  LockKeyholeIcon,
  PencilIcon,
  PlugIcon,
  RocketIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, type RefObject, useActionState, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  createTemplate,
  deleteTemplate,
  launchFromTemplate,
  publishTemplate,
  type TemplateLaunchResult,
} from "@/app/actions/templates";
import { SubmitButton } from "@/components/action-form";
import { ChoiceCard } from "@/components/connections";
import { CreateDialog } from "@/components/create-dialog";
import { LaunchShortcut, RepositoryField, Segmented } from "@/components/launch-dialog";
import { MachineSizeField } from "@/components/machine-size-field";
import { type ModelCatalog, ModelFields } from "@/components/model-fields";
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
import { NativeSelect } from "@/components/ui/native-select";
import { RadioGroup } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action";
import { PROVIDER_LABELS } from "@/lib/golden-form";
import { HARNESS_LABELS } from "@/lib/labels";
import { HARNESS_PATH, launchDefault } from "@/lib/model-accounts";
import { isSubmitShortcut } from "@/lib/shortcut";
import type { TemplateLaunchTarget } from "@/lib/template-launch";
import {
  MAX_TEMPLATE_NAME,
  newRequestKey,
  type TemplateDefinition,
  type TemplateLookups,
  type TemplateScope,
  ttlOptions,
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
      className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/25 bg-primary/10 text-primary [&_svg]:size-4"
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
 * The create flow (#949), the shared {@link CreateDialog}: one form in two steps so it fits a laptop. The first
 * step holds what defines a template (its name, who can use it, the environment and the agent); the second, the
 * optional tools and variables. Who can use it cannot be changed later, so it is marked.
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
      label="New"
      title="New template"
      description="A preset agents start from: an environment, tools, a model and variables."
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
  const id = useId();
  const [state, formAction] = useActionState(action, null);
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState(editing?.name ?? "");
  const [scope, setScope] = useState<TemplateScope>(editing?.scope ?? "personal");
  const [golden, setGolden] = useState(editing?.definition.goldenId ?? "");
  const [harness, setHarness] = useState<Harness>(editing?.definition.harness ?? "claude");
  const [keepAccount, setKeepAccount] = useState(true);
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
  // A step change moves focus to the new step, so a keyboard or screen reader user lands where the form went.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    root.current?.querySelector<HTMLElement>(`[data-template-step="${step}"] [data-step-heading]`)?.focus();
  }, [step]);

  // A list that could not be read would silently drop what the current revision chose from it: no publication.
  const lost = editing ? unreadableSelections(editing.definition, lookups) : null;
  const environments = lookups.goldens.filter((row) => scope === "personal" || row.visibility === "org");
  const chosen = lookups.goldens.find((row) => row.id === golden);
  const goldenProblem =
    chosen && scope === "org" && chosen.visibility !== "org"
      ? `${chosen.name} is private: an organization template needs a shared environment.`
      : null;

  function next() {
    if (!name.trim()) return setProblem("Name the template.");
    const otherModel = root.current?.querySelector<HTMLInputElement>('input[name="other_model"]');
    if (otherModel && !otherModel.value.trim()) return setProblem("Enter the model id.");
    if (!chosen) return setProblem("Choose an environment.");
    if (!chosen.ready) return setProblem(`${chosen.name} has no snapshot yet: snapshot it first.`);
    if (goldenProblem) return setProblem(goldenProblem);
    setProblem(null);
    setStep(2);
  }

  return (
    <form
      ref={root}
      action={formAction}
      className="space-y-4"
      data-template-form
      // Enter in a step-1 field goes to the next step; only step 2 publishes.
      onSubmit={(event) => {
        if (step === 2) return;
        event.preventDefault();
        next();
      }}
    >
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="scope" value={scope} />
      {editing && (
        <>
          <input type="hidden" name="id" value={editing.id} />
          <input type="hidden" name="revision" value={editing.revision} />
          <input type="hidden" name="name" value={editing.name} />
        </>
      )}
      <Steps step={step} />
      {/* A refusal stays in view whichever step is shown. */}
      <ResultLine result={state} />

      <div hidden={step !== 1} className="space-y-4" data-template-step="1">
        <h3 data-step-heading tabIndex={-1} className="sr-only">
          Step 1 of 2: basics
        </h3>
        {!editing && (
          <div className="space-y-2">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={MAX_TEMPLATE_NAME}
              autoComplete="off"
              placeholder="Backend with Sentry"
            />
          </div>
        )}
        {!editing && (
          <fieldset className="space-y-2">
            <legend className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm font-medium">
              Who can use it
              <span className="inline-flex items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning [&_svg]:size-3">
                <LockIcon aria-hidden /> Cannot be changed later
              </span>
            </legend>
            <RadioGroup
              value={scope}
              onValueChange={(value) => setScope(value as TemplateScope)}
              aria-label="Who can use it"
              className="sm:grid-cols-2"
            >
              <ChoiceCard value="personal" icon={<UserIcon />} title="Personal" hint="Only you launch it." />
              <ChoiceCard
                value="org"
                disabled={!isAdmin}
                icon={<UsersIcon />}
                title={`Org (${orgName})`}
                hint={isAdmin ? "Every member launches it. Only admins change it." : "Only an org admin adds these."}
              />
            </RadioGroup>
          </fieldset>
        )}
        <div className="space-y-2">
          <Label htmlFor={`${id}-golden`}>Environment</Label>
          <NativeSelect
            id={`${id}-golden`}
            name="golden"
            value={golden}
            onChange={(event) => setGolden(event.target.value)}
            aria-describedby={`${id}-golden-hint`}
            aria-invalid={goldenProblem ? true : undefined}
          >
            <option value="">Choose an environment</option>
            {environments.map((row) => (
              <option key={row.id} value={row.id} disabled={!row.ready}>
                {row.name} on {PROVIDER_LABELS[row.provider]}
                {row.ready ? "" : " (no snapshot yet)"}
              </option>
            ))}
          </NativeSelect>
          <p
            id={`${id}-golden-hint`}
            className={cn("text-xs", goldenProblem ? "text-destructive" : "text-muted-foreground")}
          >
            {goldenProblem ??
              (scope === "org"
                ? "Shared environments only. Launches use its latest snapshot."
                : "Launches use its latest snapshot.")}
          </p>
        </div>
        <Segmented
          legend="Agent"
          name="harness"
          value={harness}
          onChange={setHarness}
          options={(Object.keys(catalog) as Harness[]).map((value) => ({ value, label: HARNESS_LABELS[value] }))}
        />
        {!keepingPinnedAccount && accountSelection && accountSelection !== "resolved" && (
          <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
            {accountSelection === "ambiguous"
              ? `Several ${HARNESS_LABELS[harness]} accounts are available. Set a default in `
              : `No usable ${HARNESS_LABELS[harness]} account is available to you in this organization. Add or reconnect one in `}
            <Link className="underline" href={HARNESS_PATH}>
              Start with &gt; Harness
            </Link>
            {accountSelection === "ambiguous" ? "." : " or choose another agent."} You can save this template, but
            launching it requires {accountSelection === "ambiguous" ? "an unambiguous account selection" : "an account"}
            .
          </p>
        )}
        <ModelFields
          key={harness}
          idPrefix={id}
          harness={harness}
          catalog={catalog}
          {...(editing && editing.definition.harness === harness
            ? { initial: { model: editing.definition.model, effort: editing.definition.reasoningEffort } }
            : {})}
        />
        {editing?.definition.modelAccount && harness === editing.definition.harness && (
          <Label
            htmlFor={`${id}-keep-account`}
            className="flex items-start gap-3 rounded-md border p-3 text-sm font-normal"
            data-keep-account
          >
            <Checkbox
              id={`${id}-keep-account`}
              name="keep_account"
              value="on"
              checked={keepAccount}
              onCheckedChange={(value) => setKeepAccount(value === true)}
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium">Keep its pinned model account</span>
              <span className="block text-xs text-muted-foreground">
                Set over the API. Untick to let each launch use the launcher's own account.
              </span>
            </span>
          </Label>
        )}
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="button" onClick={next} data-template-next>
            Next: tools and variables
          </Button>
        </div>
      </div>

      <div hidden={step !== 2} className="space-y-4" data-template-step="2">
        <h3 data-step-heading tabIndex={-1} className="sr-only">
          Step 2 of 2: tools and variables
        </h3>
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
              note: row.status === "connected" ? (row.scope === "org" ? "Org" : "Personal") : "Not connected",
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
          hint="Each value is copied into the sandbox at launch, under its own name unless the revision named it otherwise. Publishing uses its current version."
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
          hint="Only names and scope are shown. Values are delivered as environment variables to the selected agent."
        />
        {lost && (
          <p role="alert" className="text-sm text-destructive" data-template-lost>
            {lost}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => setStep(1)}>
            <ArrowLeftIcon /> Back
          </Button>
          <div className="flex flex-col items-stretch gap-1 sm:items-end">
            <SubmitButton data-template-publish {...(lost ? { disabled: true } : {})}>
              {editing ? `Publish revision ${editing.revision + 1}` : "Publish template"}
            </SubmitButton>
            <p className="text-xs text-muted-foreground">
              {editing ? "Revision" : "Revision 1"} cannot be edited once published.
            </p>
          </div>
        </div>
      </div>
    </form>
  );
}

/** The two steps of the form, as a sequence: where the person is, and what comes next. */
function Steps({ step }: { step: 1 | 2 }) {
  const items = [
    { n: 1, label: "Basics" },
    { n: 2, label: "Tools and variables" },
  ] as const;
  return (
    <ol className="grid grid-cols-2 gap-2" aria-label="Steps">
      {items.map((item) => (
        <li
          key={item.n}
          aria-current={item.n === step ? "step" : undefined}
          className={cn(
            "flex items-center gap-2 border-t-2 pt-2 text-xs",
            item.n <= step ? "border-primary text-foreground" : "border-border text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium tabular-nums",
              item.n <= step ? "bg-primary text-primary-foreground" : "bg-muted",
            )}
          >
            {item.n}
          </span>
          <span className="truncate font-medium">{item.label}</span>
        </li>
      ))}
    </ol>
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
  options: { id: string; label: string; note: string; disabled?: boolean }[];
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

/** The template's choices, read-only: what a launch from it will use. */
function Preset({ target }: { target: TemplateLaunchTarget }) {
  const facts = [
    {
      key: "environment",
      icon: <LayersIcon />,
      label: "Environment",
      text: `${target.goldenName ?? "Unavailable"} on ${PROVIDER_LABELS[target.definition.provider]}`,
    },
    { key: "agent", icon: <CpuIcon />, label: "Agent", text: target.agent },
    {
      key: "tools",
      icon: <PlugIcon />,
      label: "Tools",
      text: target.tools.length ? target.tools.join(", ") : "None",
    },
    {
      key: "variables",
      icon: <BracesIcon />,
      label: "Variables",
      text: target.definition.variables.length
        ? target.definition.variables.map((binding) => binding.key).join(", ")
        : "None",
    },
  ];
  return (
    <dl
      className="grid gap-x-3 gap-y-1.5 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)]"
      data-template-preset
    >
      {facts.map((fact) => (
        <div key={fact.key} className="contents" data-preset-fact={fact.key}>
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
            <span aria-hidden className="contents">
              {fact.icon}
            </span>
            {fact.label}
          </dt>
          <dd className={cn("min-w-0 break-words", fact.key === "variables" && "font-mono text-xs leading-5")}>
            {fact.text}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A launch from one template revision. Everything the template chose is shown, not editable; only the task, the
 * project, the machine size and how long it runs can change. One request key per opening: a retry after a lost
 * answer returns that launch instead of starting another, and a definite refusal takes a fresh key.
 */
export function TemplateLaunchForm({ target }: { target: TemplateLaunchTarget }) {
  const id = useId();
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const run = useCallback(async (previous: TemplateLaunchResult | null, data: FormData) => {
    const result = await launchFromTemplate(previous, data);
    if (!result.ok && !result.pending) setRequestKey(newRequestKey());
    return result;
  }, []);
  const [state, formAction] = useActionState(run, null);
  const [project, setProject] = useState(target.repositories.length === 1 ? (target.repositories[0] ?? "") : "");
  const root = useRef<HTMLFormElement>(null);
  useKeepOnReset(root);
  useEffect(() => {
    const form = root.current;
    if (!form) return;
    const shortcut = (event: KeyboardEvent) => {
      if (!isSubmitShortcut(event)) return;
      event.preventDefault();
      const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (button && !button.disabled) form.requestSubmit(button);
    };
    form.addEventListener("keydown", shortcut);
    return () => form.removeEventListener("keydown", shortcut);
  }, []);
  const ttl = ttlOptions(target.definition.provider);

  return (
    <form ref={root} action={formAction} className="flex min-h-0 flex-1 flex-col" data-template-launch={target.name}>
      <input type="hidden" name="org" value={target.orgId} />
      <input type="hidden" name="id" value={target.id} />
      <input type="hidden" name="revision" value={target.revision} />
      <input type="hidden" name="request_key" value={requestKey} />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 pb-4">
        <Preset target={target} />
        <div className="space-y-2">
          <Label htmlFor={`${id}-prompt`}>Task</Label>
          <Textarea
            id={`${id}-prompt`}
            name="prompt"
            rows={4}
            className="max-h-[40dvh] min-h-24"
            placeholder="What should the agent do? Leave empty to start idle."
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {target.repositories.length > 0 && (
            <RepositoryField idPrefix={id} repositories={target.repositories} onChange={setProject} />
          )}
          {target.sizing && (
            <MachineSizeField
              idPrefix={id}
              provider={target.definition.provider}
              policy={target.sizing.policy}
              repositoryDir={project}
            />
          )}
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`${id}-ttl`}>Runs for</Label>
            <NativeSelect id={`${id}-ttl`} name="ttl" defaultValue="">
              {ttl.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      </div>
      <div className="space-y-2 border-t px-6 py-4">
        {state && !state.ok && (
          <p role="alert" className={cn("text-sm", state.pending ? "text-warning" : "text-destructive")}>
            {state.error}{" "}
            {state.pending && (
              <Link className="underline underline-offset-4" href="/sandboxes">
                Open Sandboxes
              </Link>
            )}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          {target.blocker && (
            <p id={`${id}-blocked`} className="mr-auto text-xs text-warning">
              {target.blocker}
            </p>
          )}
          <SubmitButton
            className="w-full sm:w-auto"
            {...(target.blocker ? { disabled: true, "aria-describedby": `${id}-blocked` } : {})}
          >
            <RocketIcon /> Launch
            <LaunchShortcut />
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}

/** The Launch button of a template's row and panel. */
export function TemplateLaunchDialog({
  target,
  size = "sm",
}: {
  target: TemplateLaunchTarget;
  size?: "sm" | "default";
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size={size} aria-label={`Launch from ${target.name}`} data-launch-template={target.name}>
          <RocketIcon /> Launch
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6 pb-4 pr-12">
          <DialogTitle className="truncate">Launch {target.name}</DialogTitle>
          <DialogDescription>
            Revision {target.revision}. Its choices are fixed; the task and the run are yours.
          </DialogDescription>
        </DialogHeader>
        <TemplateLaunchForm target={target} />
      </DialogContent>
    </Dialog>
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
  const [deleted, deleteAction] = useActionState(run, null);
  return (
    <div className="flex flex-wrap gap-2 border-t pt-4">
      <Button variant="outline" size="sm" onClick={() => setDialog("edit")} data-edit-template>
        <PencilIcon /> New revision
      </Button>
      <Button variant="destructive-outline" size="sm" onClick={() => setDialog("delete")}>
        <Trash2Icon /> Delete
      </Button>
      <Dialog open={dialog === "edit"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>New revision of {editing.name}</DialogTitle>
            <DialogDescription>
              Revision {editing.revision} stays as it is. Launches use the new one from now on.
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
            <AlertDialogTitle>Delete {editing.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Nobody can launch from it any more. Sandboxes already launched from it keep running. This cannot be
              undone.
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
              <SubmitButton variant="destructive">Delete</SubmitButton>
            </form>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
