"use client";

import {
  CircleAlertIcon,
  GlobeIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  TerminalIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { type ReactNode, useActionState, useEffect, useId, useRef, useState } from "react";
import {
  addConnection,
  checkConnection,
  connectConnection,
  deleteConnection,
  editConnection,
  revokeConnection,
  setConnectionEnabled,
} from "@/app/actions/connections";
import { SubmitButton } from "@/components/action-form";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action";
import {
  authLabel,
  type ConnectionAuthType,
  type ConnectionScope,
  type McpConnection,
  parseStdioImport,
  STATUS_INFO,
  scopeLabel,
  statusLabel,
  transportLabel,
} from "@/lib/connections";
import { cn } from "@/lib/utils";

type Action = (previous: ActionResult | null, data: FormData) => Promise<ActionResult>;

const TONE: Record<string, string> = {
  ok: "border-success/40 bg-success/10 text-success",
  warn: "border-warning/40 bg-warning/10 text-warning",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
  muted: "text-muted-foreground",
};

export function ConnectionStatusBadge({ connection }: { connection: Pick<McpConnection, "status" | "transport"> }) {
  const info = STATUS_INFO[connection.status];
  return (
    <Badge variant="outline" className={TONE[info.tone]} data-connection-status={connection.status}>
      {statusLabel(connection)}
    </Badge>
  );
}

export function ScopeBadge({ scope }: { scope: ConnectionScope }) {
  return (
    <Badge variant={scope === "personal" ? "secondary" : "outline"} className="gap-1">
      {scope === "personal" ? <UserIcon /> : <UsersIcon />}
      {scopeLabel(scope)}
    </Badge>
  );
}

function ResultLine({ result, className }: { result: ActionResult | null; className?: string }) {
  if (!result) return null;
  return (
    <p
      role={result.ok ? "status" : "alert"}
      className={cn("text-sm", result.ok ? "text-success" : "text-destructive", className)}
    >
      {result.ok ? result.message : result.error}
    </p>
  );
}

/* ---------------------------------------------------------------- add or edit a connection */

type Kind = "remote" | "stdio";
const AUTH_CHOICES: { value: ConnectionAuthType; hint: string }[] = [
  {
    value: "auto",
    hint: "Armada probes the server: a public server connects at once, one that needs sign-in opens its login page.",
  },
  { value: "oauth", hint: "Always sign in through the server's login page in this browser." },
  { value: "none", hint: "The server needs no authentication." },
  { value: "bearer", hint: "A token sent as Authorization: Bearer. Stored encrypted, never shown again." },
  { value: "headers", hint: "Header values stored encrypted and never shown again. Header names stay visible." },
];

type HeaderRow = { key: number; name: string };

/**
 * The Add connection dialog. Non-secret fields are controlled, so they survive a refused submission; the
 * token, header values and client secret are uncontrolled password fields that React empties after every
 * submission, and nothing echoes them back. A success remounts the fields, so the dialog starts clean.
 */
export function AddConnectionDialog({ orgId, orgName, isAdmin }: { orgId: string; orgName: string; isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(addConnection, null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (state?.ok) setGeneration((value) => value + 1);
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon /> Add connection
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add an MCP connection</DialogTitle>
          <DialogDescription>
            Connect a server once in {orgName}, then pick it when you launch a sandbox.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="org" value={orgId} />
          <AddFields key={generation} orgName={orgName} isAdmin={isAdmin} result={state} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddFields({ orgName, isAdmin, result }: { orgName: string; isAdmin: boolean; result: ActionResult | null }) {
  const [kind, setKind] = useState<Kind>("remote");
  const [scope, setScope] = useState<ConnectionScope>("personal");
  const [name, setName] = useState("");
  const [authType, setAuthType] = useState<ConnectionAuthType>("auto");
  const id = useId();
  const sharedSignIn = scope === "org" && kind === "remote" && (authType === "oauth" || authType === "auto");

  return (
    <>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Server</legend>
        <div className="grid grid-cols-2 gap-2">
          <ChoiceCard
            name={`${id}-kind`}
            checked={kind === "remote"}
            onChange={() => setKind("remote")}
            icon={<GlobeIcon />}
            title="Remote URL"
            hint="Most servers"
          />
          <ChoiceCard
            name={`${id}-kind`}
            checked={kind === "stdio"}
            onChange={() => setKind("stdio")}
            icon={<TerminalIcon />}
            title="stdio command"
            hint="Advanced"
          />
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Who uses it</legend>
        <input type="hidden" name="scope" value={scope} />
        <div className="grid gap-2 sm:grid-cols-2">
          <ChoiceCard
            name={`${id}-scope`}
            checked={scope === "personal"}
            onChange={() => setScope("personal")}
            icon={<UserIcon />}
            title="Personal"
            hint="Your account, your private sandboxes only."
          />
          <ChoiceCard
            name={`${id}-scope`}
            checked={scope === "org"}
            onChange={() => setScope("org")}
            disabled={!isAdmin}
            icon={<UsersIcon />}
            title={`Org (${orgName})`}
            hint={isAdmin ? "One shared account for org sandboxes." : "Only an org admin adds these."}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          This cannot change later. To share a personal server with the org, an admin adds it again as an org
          connection.
        </p>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={120}
          autoComplete="off"
          placeholder={kind === "remote" ? "Linear" : "Filesystem"}
        />
      </div>

      {kind === "remote" ? (
        <RemoteFields idPrefix={id} authType={authType} onAuthType={setAuthType} />
      ) : (
        <StdioFields idPrefix={id} onName={(imported) => setName((current) => current || imported)} />
      )}
      {sharedSignIn && (
        <p className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            If the server asks for sign-in, the account you authorize becomes the org's shared identity: every org
            sandbox acts as it. Sign in with a service account, not your personal login.
          </span>
        </p>
      )}

      <ResultLine result={result} />
      <div className="flex flex-wrap justify-end gap-2">
        <SubmitButton>{kind === "remote" ? "Add and connect" : "Add connection"}</SubmitButton>
      </div>
    </>
  );
}

/** URL, transport and authentication of a remote server, shared by Add and Edit. */
function RemoteFields({
  idPrefix: id,
  initialUrl = "",
  initialTransport = "http",
  authType,
  onAuthType,
}: {
  idPrefix: string;
  initialUrl?: string;
  initialTransport?: string;
  authType: ConnectionAuthType;
  onAuthType: (value: ConnectionAuthType) => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [transport, setTransport] = useState(initialTransport);
  const [headers, setHeaders] = useState<HeaderRow[]>([{ key: 0, name: "" }]);
  const nextKey = useRef(1);
  const authHint = AUTH_CHOICES.find((choice) => choice.value === authType)?.hint;
  return (
    <>
      <input type="hidden" name="kind" value="remote" />
      <div className="space-y-2">
        <Label htmlFor={`${id}-url`}>Server URL</Label>
        <Input
          id={`${id}-url`}
          name="url"
          type="url"
          inputMode="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
          autoComplete="off"
          spellCheck={false}
          placeholder="https://mcp.example.com/mcp"
          aria-describedby={`${id}-url-hint`}
        />
        <p id={`${id}-url-hint`} className="text-xs text-muted-foreground">
          Query parameters such as project_ref are fine. Keys and tokens go in the authentication below.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${id}-transport`}>Transport</Label>
          <NativeSelect
            id={`${id}-transport`}
            name="transport"
            value={transport}
            onChange={(event) => setTransport(event.target.value)}
          >
            <option value="http">Streamable HTTP</option>
            <option value="sse">SSE (legacy)</option>
          </NativeSelect>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-auth`}>Authentication</Label>
          <NativeSelect
            id={`${id}-auth`}
            name="auth_type"
            value={authType}
            aria-describedby={`${id}-auth-hint`}
            onChange={(event) => onAuthType(event.target.value as ConnectionAuthType)}
          >
            {AUTH_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {authLabel(choice.value)}
                {choice.value === "auto" ? " (recommended)" : ""}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <p id={`${id}-auth-hint`} className="text-xs text-muted-foreground">
        {authHint}
      </p>
      {authType === "bearer" && (
        <div className="space-y-2">
          <Label htmlFor={`${id}-bearer`}>Bearer token</Label>
          <Input
            id={`${id}-bearer`}
            name="bearer_token"
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the token"
          />
        </div>
      )}
      {authType === "headers" && (
        <HeaderFields idPrefix={id} rows={headers} onChange={setHeaders} nextKey={() => nextKey.current++} />
      )}
      {authType === "oauth" && (
        <details className="rounded-md border p-3 text-sm [&[open]>summary]:mb-3">
          <summary className="cursor-pointer font-medium">Preregistered OAuth client (optional)</summary>
          <p className="mb-3 text-xs text-muted-foreground">
            Only for a server that offers neither client metadata nor dynamic registration. Otherwise leave empty.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${id}-client-id`}>Client ID</Label>
              <Input id={`${id}-client-id`} name="oauth_client_id" autoComplete="off" spellCheck={false} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-client-secret`}>Client secret</Label>
              <Input
                id={`${id}-client-secret`}
                name="oauth_client_secret"
                type="password"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
        </details>
      )}
    </>
  );
}

/** A radio drawn as a card: the native input covers the card, so a click, a tap or the arrow keys pick it. */
export function ChoiceCard({
  name,
  checked,
  onChange,
  disabled,
  icon,
  title,
  hint,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  icon: ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <label
      className={cn(
        "relative flex cursor-pointer gap-3 rounded-md border p-3 text-sm transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0",
        checked ? "border-primary bg-accent" : "hover:bg-accent/50",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="absolute inset-0 size-full cursor-pointer appearance-none rounded-md opacity-0 disabled:cursor-not-allowed"
      />
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

function HeaderFields({
  idPrefix,
  rows,
  onChange,
  nextKey,
}: {
  idPrefix: string;
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  nextKey: () => number;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Headers</legend>
      {rows.map((row, index) => (
        <div key={row.key} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-hn-${row.key}`} className="text-xs text-muted-foreground">
              Header {index + 1} name
            </Label>
            <Input
              id={`${idPrefix}-hn-${row.key}`}
              name="header_name"
              value={row.name}
              onChange={(event) =>
                onChange(rows.map((item) => (item.key === row.key ? { ...item, name: event.target.value } : item)))
              }
              autoComplete="off"
              spellCheck={false}
              placeholder="X-Api-Key"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-hv-${row.key}`} className="text-xs text-muted-foreground">
              Header {index + 1} value
            </Label>
            <Input
              id={`${idPrefix}-hv-${row.key}`}
              name="header_value"
              type="password"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove header ${index + 1}`}
            disabled={rows.length === 1}
            onClick={() => onChange(rows.filter((item) => item.key !== row.key))}
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { key: nextKey(), name: "" }])}
      >
        <PlusIcon /> Add header
      </Button>
    </fieldset>
  );
}

function StdioFields({
  idPrefix,
  onName,
  initialCommand = "",
  initialArgs = "",
}: {
  idPrefix: string;
  onName?: (name: string) => void;
  initialCommand?: string;
  initialArgs?: string;
}) {
  const [command, setCommand] = useState(initialCommand);
  const [args, setArgs] = useState(initialArgs);
  const [importText, setImportText] = useState("");
  const [importResult, setImportResult] = useState<ActionResult | null>(null);

  function runImport() {
    const parsed = parseStdioImport(importText);
    if (!parsed.ok) {
      setImportResult({ ok: false, error: parsed.error });
      return;
    }
    setCommand(parsed.value.command);
    setArgs(parsed.value.args.join("\n"));
    if (parsed.value.name) onName?.(parsed.value.name);
    setImportText("");
    setImportResult({ ok: true, message: "Imported. Check the command and arguments below." });
  }

  return (
    <div className="space-y-4">
      <input type="hidden" name="kind" value="stdio" />
      <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">Runs inside each sandbox</span> that you launch with it, as the
          agent's user, with the sandbox's files. Armada never runs it on its own servers.
        </p>
        <p>
          Pin an exact version so every sandbox runs the same code, for example{" "}
          <code className="font-mono text-foreground">npx -y @modelcontextprotocol/server-filesystem@2026.1.14</code>.
          Any other program must already be installed in the golden. A stdio server takes no authentication: Armada
          passes no secret into it, and everyone who can use the connection sees its command.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-import`}>Import a JSON definition (optional)</Label>
        <Textarea
          id={`${idPrefix}-import`}
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
          rows={3}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={'{"mcpServers": {"filesystem": {"command": "npx", "args": ["-y", "…@1.2.3"]}}}'}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={runImport} disabled={!importText.trim()}>
            Import
          </Button>
          <ResultLine result={importResult} className="text-xs" />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-command`}>Command</Label>
        <Input
          id={`${idPrefix}-command`}
          name="command"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          required
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          placeholder="npx"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-args`}>Arguments, one per line</Label>
        <Textarea
          id={`${idPrefix}-args`}
          name="args"
          value={args}
          onChange={(event) => setArgs(event.target.value)}
          rows={3}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={"-y\n@modelcontextprotocol/server-filesystem@2026.1.14\n/workspace"}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- one connection */

/** A button bound to a server action; its result goes to the card's single live line. */
function RowAction({
  action,
  fields,
  onResult,
  children,
  variant = "outline",
  label,
  pendingText,
  onPending,
  hidden = false,
}: {
  action: Action;
  fields: Record<string, string>;
  onResult: (result: ActionResult) => void;
  children: ReactNode;
  variant?: "outline" | "ghost" | "default" | "destructive";
  label?: string;
  /** Shown on the card's live line while the server works, such as "Disabling…". */
  pendingText?: string;
  hidden?: boolean;
  onPending?: (text: string | null) => void;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  useEffect(() => {
    if (state) onResult(state);
  }, [state, onResult]);
  useEffect(() => {
    if (pendingText) onPending?.(pending ? pendingText : null);
  }, [pending, pendingText, onPending]);
  return (
    <form action={formAction} hidden={hidden}>
      {Object.entries(fields).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <SubmitButton variant={variant} size="sm" aria-label={label}>
        {children}
      </SubmitButton>
    </form>
  );
}

export function ConnectionCard({
  connection,
  canManage,
  notice,
}: {
  connection: McpConnection;
  canManage: boolean;
  notice?: ActionResult | null;
}) {
  const [result, setResult] = useState<ActionResult | null>(notice ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const target = { org: connection.orgId, id: connection.id };
  const remote = connection.transport !== "stdio";
  const enabled = connection.status !== "disabled";
  const connectLabel = !remote
    ? "Configure"
    : connection.status === "needs_reconnect" || (connection.status === "connected" && connection.authType === "oauth")
      ? "Reconnect"
      : "Connect";
  // Remote: connect when not connected, or sign in again with OAuth. Stdio: configure for launch when it is not.
  const canConnect = enabled && (connection.status !== "connected" || (remote && connection.authType === "oauth"));
  const counts = [
    ["tools", connection.toolCount],
    ["resources", connection.resourceCount],
    ["prompts", connection.promptCount],
  ] as const;
  const known = counts.filter(([, value]) => value !== undefined);

  return (
    <li className="space-y-3 p-4" data-connection={connection.name} aria-labelledby={`connection-${connection.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`connection-${connection.id}`} className="font-medium">
              {connection.name}
            </h3>
            <ConnectionStatusBadge connection={connection} />
            <ScopeBadge scope={connection.scope} />
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" title={connection.url ?? undefined}>
            {remote
              ? (connection.url ?? "URL hidden")
              : [connection.command, ...(connection.args ?? [])].filter(Boolean).join(" ")}
          </p>
        </div>
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <div>
            <dt className="sr-only">Transport</dt>
            <dd className="text-muted-foreground">{transportLabel(connection.transport)}</dd>
          </div>
          {remote && (
            <div>
              <dt className="sr-only">Authentication</dt>
              <dd className="text-muted-foreground">{authLabel(connection.authType)}</dd>
            </div>
          )}
        </dl>
      </div>

      <dl className="grid gap-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
        {connection.accountLabel && (
          <>
            <dt className="text-xs text-muted-foreground">Signed in as</dt>
            <dd>{connection.accountLabel}</dd>
          </>
        )}
        <dt className="text-xs text-muted-foreground">Offers</dt>
        <dd>
          {!remote
            ? "Starts inside each sandbox launched with it; the agent sees its tools there. Armada never runs it."
            : known.length === 0
              ? "Unknown until connected"
              : known.map(([label, value]) => `${value} ${value === 1 ? label.slice(0, -1) : label}`).join(" · ")}
        </dd>
        {connection.lastError && (
          <>
            <dt className="text-xs text-destructive">Last error</dt>
            <dd className="text-destructive">{connection.lastError}</dd>
          </>
        )}
      </dl>

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          {/* Stays mounted when it no longer applies, so the result of the connect it just ran is still shown. */}
          <RowAction
            action={connectConnection}
            fields={target}
            onResult={setResult}
            variant="default"
            label={`${connectLabel} ${connection.name}`}
            hidden={!canConnect}
          >
            {connectLabel}
          </RowAction>
          {remote && (
            <RowAction action={checkConnection} fields={target} onResult={setResult} label={`Check ${connection.name}`}>
              <RefreshCwIcon /> Check
            </RowAction>
          )}
          <EditConnectionDialog connection={connection} onResult={setResult} />
          <RowAction
            action={setConnectionEnabled}
            fields={{ ...target, enabled: String(!enabled) }}
            onResult={setResult}
            variant="ghost"
            label={`${enabled ? "Disable" : "Enable"} ${connection.name}`}
            pendingText={enabled ? "Disabling…" : "Enabling…"}
            onPending={setBusy}
          >
            {enabled ? "Disable" : "Enable"}
          </RowAction>
          {remote && connection.authType !== "none" && (
            <ConfirmAction
              action={revokeConnection}
              fields={target}
              onResult={setResult}
              trigger="Revoke"
              title={`Revoke access to ${connection.name}?`}
              description="Armada deletes the stored authorization. Sandboxes launched later cannot use the server until someone connects it again. The definition stays."
              confirm="Revoke access"
            />
          )}
          <ConfirmAction
            action={deleteConnection}
            fields={target}
            onResult={setResult}
            trigger="Delete"
            title={`Delete ${connection.name}?`}
            description="The connection and its stored authorization are removed. New launches can no longer select it."
            confirm="Delete connection"
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Managed by the org's admins.</p>
      )}
      {busy ? (
        <p role="status" className="text-sm text-muted-foreground">
          {busy}
        </p>
      ) : (
        <ResultLine result={result} />
      )}
    </li>
  );
}

function ConfirmAction({
  action,
  fields,
  onResult,
  trigger,
  title,
  description,
  confirm,
}: {
  action: Action;
  fields: Record<string, string>;
  onResult: (result: ActionResult) => void;
  trigger: string;
  title: string;
  description: string;
  confirm: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (!state) return;
    onResult(state);
    if (state.ok) setOpen(false);
  }, [state, onResult]);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
          {trigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {state && !state.ok && <ResultLine result={state} />}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={formAction}>
            {Object.entries(fields).map(([key, value]) => (
              <input key={key} type="hidden" name={key} value={value} />
            ))}
            <SubmitButton variant="destructive">{confirm}</SubmitButton>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Edits a connection. The server clears its stored authentication and revokes running leases on any update,
 * which the dialog says before the person saves; a remote connection is then connected again.
 */
function EditConnectionDialog({
  connection,
  onResult,
}: {
  connection: McpConnection;
  onResult: (result: ActionResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(editConnection, null);
  const [generation, setGeneration] = useState(0);
  const [name, setName] = useState(connection.name);
  const [authType, setAuthType] = useState<ConnectionAuthType>(connection.authType);
  const id = useId();
  useEffect(() => {
    if (!state) return;
    onResult(state);
    if (state.ok) {
      setOpen(false);
      setGeneration((value) => value + 1);
    }
  }, [state, onResult]);
  const remote = connection.transport !== "stdio";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Edit ${connection.name}`}>
          <PencilIcon /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit {connection.name}</DialogTitle>
          <DialogDescription>{scopeLabel(connection.scope)} connection. Who uses it cannot change.</DialogDescription>
        </DialogHeader>
        <form key={generation} action={formAction} className="space-y-4">
          <input type="hidden" name="org" value={connection.orgId} />
          <input type="hidden" name="id" value={connection.id} />
          <p className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              Saving replaces the whole definition below. Any saved sign-in, token or headers are deleted, not kept, and
              sandboxes using the connection lose it now.{" "}
              {remote
                ? "Armada connects again right after: enter the token or headers again, or sign in again."
                : "Armada configures it for launch again; sandboxes launched afterwards use the new command."}
            </span>
          </p>
          <div className="space-y-2">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={120}
              autoComplete="off"
            />
          </div>
          {remote ? (
            <RemoteFields
              idPrefix={id}
              initialUrl={connection.url ?? ""}
              initialTransport={connection.transport}
              authType={authType}
              onAuthType={setAuthType}
            />
          ) : (
            <StdioFields
              idPrefix={id}
              initialCommand={connection.command ?? ""}
              initialArgs={(connection.args ?? []).join("\n")}
            />
          )}
          {state && !state.ok && <ResultLine result={state} />}
          <SubmitButton>{remote ? "Save and reconnect" : "Save"}</SubmitButton>
        </form>
      </DialogContent>
    </Dialog>
  );
}
