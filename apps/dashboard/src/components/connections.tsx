"use client";

import {
  CircleAlertIcon,
  GlobeIcon,
  KeyRoundIcon,
  LockIcon,
  LogInIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  SettingsIcon,
  TerminalIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { type ReactNode, useActionState, useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import {
  addConnection,
  addServiceConnection,
  checkConnection,
  connectConnection,
  deleteConnection,
  editConnection,
  revokeConnection,
  setConnectionEnabled,
  updateConnectionMetadata,
} from "@/app/actions/connections";
import { SubmitButton } from "@/components/action-form";
import { CreateDialog } from "@/components/create-dialog";
import { StateCell } from "@/components/state-cell";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
import type { ActionResult } from "@/lib/action";
import {
  authLabel,
  type ConnectionAuthType,
  type ConnectionScope,
  connectAction,
  hostOf,
  type McpCatalogService,
  type McpConnection,
  parseStdioImport,
  STATUS_INFO,
  scopeLabel,
  statusLabel,
  suggestedName,
  transportLabel,
} from "@/lib/connections";
import { serviceOffer } from "@/lib/tools";
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
 * The custom server form, for anything the catalog does not offer, in {@link AddServerDialog}. Non-secret fields are controlled, so they survive a refused submission; the
 * token, header values and client secret are uncontrolled password fields that React empties after every
 * submission, and nothing echoes them back. A success remounts the fields, so the form starts clean.
 */
export function AddConnectionForm({ orgId, orgName, isAdmin }: { orgId: string; orgName: string; isAdmin: boolean }) {
  const [state, formAction] = useActionState(addConnection, null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (state?.ok) setGeneration((value) => value + 1);
  }, [state]);

  return (
    <form action={formAction} className="space-y-4" data-add-connection>
      <input type="hidden" name="org" value={orgId} />
      <AddFields key={generation} orgName={orgName} isAdmin={isAdmin} result={state} />
    </form>
  );
}

/**
 * The Tools page's add flow (#896), the dashboard's {@link CreateDialog} pattern: one short form for a custom server.
 * Catalog services are not repeated here: each is connected from its card in the page's Services section.
 */
export function AddServerDialog({ orgId, orgName, isAdmin }: { orgId: string; orgName: string; isAdmin: boolean }) {
  return (
    <CreateDialog
      label="Add server"
      title="Add a custom server"
      description="Any MCP server by URL, or a command that runs in the sandbox."
      triggerAttrs={{ "data-add-server": "" }}
    >
      <AddConnectionForm orgId={orgId} orgName={orgName} isAdmin={isAdmin} />
    </CreateDialog>
  );
}

function AddFields({ orgName, isAdmin, result }: { orgName: string; isAdmin: boolean; result: ActionResult | null }) {
  const [kind, setKind] = useState<Kind>("remote");
  const [scope, setScope] = useState<ConnectionScope>("personal");
  const [name, setName] = useState("");
  const [authType, setAuthType] = useState<ConnectionAuthType>("auto");
  const id = useId();
  const sharedSignIn = scope === "org" && kind === "remote" && (authType === "oauth" || authType === "auto");

  const nameField = (
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
        placeholder={kind === "remote" ? "Internal docs" : "Filesystem"}
      />
    </div>
  );

  return (
    <>
      <fieldset className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <legend className="float-left text-sm font-medium">Server</legend>
        <div className="grid grid-cols-2 gap-1 rounded-lg border bg-muted/50 p-1">
          <KindOption name={`${id}-kind`} checked={kind === "remote"} onChange={() => setKind("remote")}>
            <GlobeIcon /> Remote URL
          </KindOption>
          <KindOption name={`${id}-kind`} checked={kind === "stdio"} onChange={() => setKind("stdio")}>
            <TerminalIcon /> stdio command
          </KindOption>
        </div>
      </fieldset>

      {kind === "remote" ? (
        <RemoteFields idPrefix={id} authType={authType} onAuthType={setAuthType} lead={nameField} />
      ) : (
        <StdioFields idPrefix={id} onName={(imported) => setName((current) => current || imported)} lead={nameField} />
      )}

      <input type="hidden" name="scope" value={scope} />
      <ScopeChoice idPrefix={id} scope={scope} onScope={setScope} orgName={orgName} isAdmin={isAdmin} />
      {sharedSignIn && <SharedIdentityWarning />}
      <DefaultCheckbox idPrefix={id} />

      <ResultLine result={result} />
      <div className="flex flex-wrap justify-end gap-2">
        <SubmitButton>{kind === "remote" ? "Add and connect" : "Add connection"}</SubmitButton>
      </div>
    </>
  );
}

/** One side of the Server switch: a native radio drawn as a segment, so arrow keys move between the two. */
function KindOption({
  name,
  checked,
  onChange,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "relative flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0",
        checked
          ? "bg-background text-foreground shadow-xs dark:bg-input/60"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="absolute inset-0 size-full cursor-pointer appearance-none rounded-md opacity-0"
      />
      {children}
    </label>
  );
}

/** URL, transport and authentication of a remote server, shared by Add and Edit. */
function RemoteFields({
  idPrefix: id,
  initialUrl = "",
  initialTransport = "http",
  authType,
  onAuthType,
  lead,
}: {
  idPrefix: string;
  initialUrl?: string;
  initialTransport?: string;
  authType: ConnectionAuthType;
  onAuthType: (value: ConnectionAuthType) => void;
  /** A field beside the URL on a wide screen (Add's name), so the short form needs no scrolling. */
  lead?: ReactNode;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [transport, setTransport] = useState(initialTransport);
  const [headers, setHeaders] = useState<HeaderRow[]>([{ key: 0, name: "" }]);
  const nextKey = useRef(1);
  const authHint = AUTH_CHOICES.find((choice) => choice.value === authType)?.hint;
  return (
    <>
      <input type="hidden" name="kind" value="remote" />
      <div className={cn(lead && "grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]")}>
        {lead}
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
            Keys and tokens go in authentication, not the URL.
          </p>
        </div>
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
  lead,
}: {
  idPrefix: string;
  onName?: (name: string) => void;
  initialCommand?: string;
  initialArgs?: string;
  /** A field beside the command on a wide screen (Add's name), so the short form needs no scrolling. */
  lead?: ReactNode;
}) {
  const [command, setCommand] = useState(initialCommand);
  const [args, setArgs] = useState(initialArgs);
  const [importText, setImportText] = useState("");
  const [importResult, setImportResult] = useState<ActionResult | null>(null);
  // Optional, so folded: the short form keeps the scope and the submit in view on a laptop.
  const [importing, setImporting] = useState(false);

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
      <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-pretty text-muted-foreground">
        <span className="font-medium text-foreground">Runs in each sandbox launched with it</span>, never on Armada. Pin
        an exact package version, as in the example below; other programs must already be in the golden. No secret is
        passed in, and everyone who can use it sees its command.
      </p>
      <div className={cn(lead && "grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]")}>
        {lead}
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
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <Label htmlFor={`${idPrefix}-args`}>Arguments, one per line</Label>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            aria-expanded={importing}
            aria-controls={`${idPrefix}-import-area`}
            onClick={() => setImporting((open) => !open)}
          >
            Import JSON definition
          </Button>
        </div>
        {importing && (
          <div id={`${idPrefix}-import-area`} className="space-y-2 rounded-md border bg-muted/40 p-3">
            <Label htmlFor={`${idPrefix}-import`} className="text-xs text-muted-foreground">
              JSON definition
            </Label>
            <Textarea
              id={`${idPrefix}-import`}
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              rows={3}
              spellCheck={false}
              className="bg-background font-mono text-xs"
              placeholder={'{"mcpServers": {"filesystem": {"command": "npx", "args": ["-y", "…@1.2.3"]}}}'}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={runImport} disabled={!importText.trim()}>
                Import
              </Button>
              <ResultLine result={importResult} className="text-xs" />
            </div>
          </div>
        )}
        <Textarea
          id={`${idPrefix}-args`}
          name="args"
          value={args}
          onChange={(event) => setArgs(event.target.value)}
          rows={3}
          spellCheck={false}
          className="min-h-0 font-mono text-xs"
          placeholder={"-y\n@modelcontextprotocol/server-filesystem@2026.1.14\n/workspace"}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- catalog */

/** A service's initial in a quiet square: the mark of a connection without borrowing anyone's logo. */
export function ServiceMark({ label, className }: { label: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted text-sm font-semibold text-muted-foreground",
        className,
      )}
    >
      {label.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/**
 * The curated services, one card each, in the Tools page's Services section: the one place a known service is
 * connected (#896). Each card says where the service stands for the viewer and its one action: Connect, Connect
 * another account (connections are independent, so a service is added once per account), or, when this Armada
 * server cannot sign in to it yet, what the server needs and its setup guide.
 */
export function ServiceCatalog({
  services,
  connections,
  orgId,
  orgName,
  isAdmin,
}: {
  services: readonly McpCatalogService[];
  connections: readonly McpConnection[];
  orgId: string;
  orgName: string;
  isAdmin: boolean;
}) {
  const taken = connections.map((connection) => connection.name);
  return (
    <ul className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
      {services.map((service) => {
        const offer = serviceOffer(service, connections);
        const setup = offer.action === "setup";
        return (
          <li
            key={service.id}
            data-service={service.id}
            className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs"
          >
            <div className="flex min-w-0 items-start gap-3">
              <ServiceMark label={service.label} />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{service.label}</p>
                <p className="truncate text-xs text-muted-foreground" title={service.url}>
                  {hostOf(service.url)}
                </p>
              </div>
              <StateCell
                tone={offer.tone}
                label={offer.label}
                className="shrink-0"
                {...(setup ? { "data-service-setup": "" } : {})}
              />
            </div>
            <p className="flex-1 text-sm text-pretty text-muted-foreground">
              {setup
                ? (service.setupMessage ?? "Needs setup on this Armada server.")
                : offer.count > 0
                  ? `${offer.count} ${offer.count === 1 ? "account" : "accounts"} in your list. Add another for a second identity.`
                  : `Sign in once; your agents can then use ${service.label} in the sandboxes they launch.`}
            </p>
            <div className="flex justify-end">
              {setup ? (
                service.docsUrl ? (
                  <Button variant="outline" size="sm" asChild>
                    <a href={service.docsUrl} target="_blank" rel="noreferrer noopener">
                      Setup guide
                    </a>
                  </Button>
                ) : null
              ) : (
                <ConnectServiceDialog
                  service={service}
                  taken={taken}
                  another={offer.action === "another"}
                  orgId={orgId}
                  orgName={orgName}
                  isAdmin={isAdmin}
                />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Name, who uses it and the launch default for a new connection to a catalog service, then its sign-in. The name
 * is a nickname for Armada only; the account it acts as is whatever the service's sign-in returns.
 */
export function ConnectServiceDialog({
  service,
  taken,
  another,
  orgId,
  orgName,
  isAdmin,
}: {
  service: McpCatalogService;
  taken: readonly string[];
  another: boolean;
  orgId: string;
  orgName: string;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Every opening starts a fresh form: no earlier result or half-typed name carries over.
  const [generation, setGeneration] = useState(0);
  function change(next: boolean) {
    setOpen(next);
    if (!next) setGeneration((value) => value + 1);
  }
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button
          variant={another ? "outline" : "default"}
          size="sm"
          aria-label={another ? `Connect another ${service.label} account` : `Connect ${service.label}`}
        >
          {another ? "Connect another" : "Connect"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect {service.label}</DialogTitle>
          <DialogDescription>Then sign in at {service.label} with the account Armada should use.</DialogDescription>
        </DialogHeader>
        <ConnectServiceForm
          key={generation}
          service={service}
          taken={taken}
          orgId={orgId}
          orgName={orgName}
          isAdmin={isAdmin}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The form of {@link ConnectServiceDialog}. Once the server created the connection, the form gives way to the
 * outcome: submitting again would add a second connection, so what remains is finished on the connection's row.
 */
function ConnectServiceForm({
  service,
  taken,
  orgId,
  orgName,
  isAdmin,
}: {
  service: McpCatalogService;
  taken: readonly string[];
  orgId: string;
  orgName: string;
  isAdmin: boolean;
}) {
  const [state, formAction] = useActionState(addServiceConnection, null);
  const [scope, setScope] = useState<ConnectionScope>("personal");
  const id = useId();
  if (state?.created) {
    return (
      <div className="space-y-4" data-service-outcome>
        <ResultLine result={state} />
        <div className="flex justify-end">
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </div>
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="service" value={service.id} />
      <input type="hidden" name="scope" value={scope} />
      <div className="space-y-2">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          name="name"
          defaultValue={suggestedName(service.label, taken)}
          required
          maxLength={120}
          autoComplete="off"
          aria-describedby={`${id}-name-hint`}
        />
        <p id={`${id}-name-hint`} className="text-xs text-muted-foreground">
          Your label for this account, such as Work or Personal.
        </p>
      </div>
      <ScopeChoice idPrefix={id} scope={scope} onScope={setScope} orgName={orgName} isAdmin={isAdmin} />
      {scope === "org" && <SharedIdentityWarning />}
      <DefaultCheckbox idPrefix={id} />
      <ResultLine result={state} />
      <div className="flex justify-end">
        <SubmitButton>Continue to {service.label}</SubmitButton>
      </div>
    </form>
  );
}

function ScopeChoice({
  idPrefix,
  scope,
  onScope,
  orgName,
  isAdmin,
}: {
  idPrefix: string;
  scope: ConnectionScope;
  onScope: (scope: ConnectionScope) => void;
  orgName: string;
  isAdmin: boolean;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm font-medium">
        Who uses it
        <span className="inline-flex items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning [&_svg]:size-3">
          <LockIcon aria-hidden /> Cannot be changed later
        </span>
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <ChoiceCard
          name={`${idPrefix}-scope`}
          checked={scope === "personal"}
          onChange={() => onScope("personal")}
          icon={<UserIcon />}
          title="Personal"
          hint="Your account, in the sandboxes you launch."
        />
        <ChoiceCard
          name={`${idPrefix}-scope`}
          checked={scope === "org"}
          onChange={() => onScope("org")}
          disabled={!isAdmin}
          icon={<UsersIcon />}
          title={`Org (${orgName})`}
          hint={isAdmin ? "One shared account for every member's sandboxes." : "Only an org admin adds these."}
        />
      </div>
    </fieldset>
  );
}

function SharedIdentityWarning() {
  return (
    <p className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
      <span>
        If the server asks for sign-in, the account you authorize becomes the org's shared identity: every org sandbox
        acts as it. Sign in with a service account, not your personal login.
      </span>
    </p>
  );
}

/** Whether a new connection starts out included in launches that name no connections. */
function DefaultCheckbox({ idPrefix }: { idPrefix: string }) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={`${idPrefix}-default`}
        type="checkbox"
        name="default_for_launch"
        aria-describedby={`${idPrefix}-default-hint`}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
      <div className="space-y-0.5">
        <Label htmlFor={`${idPrefix}-default`}>Include in new launches by default</Label>
        <p id={`${idPrefix}-default-hint`} className="text-xs text-muted-foreground">
          Preselected when you launch. You can still remove it each time.
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- one connection */

/** A button bound to a server action; its result goes to the row's single live line. */
function RowAction({
  action,
  fields,
  onResult,
  children,
  variant = "outline",
  label,
  hidden = false,
}: {
  action: Action;
  fields: Record<string, string>;
  onResult: (result: ActionResult) => void;
  children: ReactNode;
  variant?: "outline" | "ghost" | "default" | "destructive";
  label?: string;
  hidden?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (state) onResult(state);
  }, [state, onResult]);
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

/**
 * Include-by-default, as a switch. It only changes metadata (`mcp/metadata`): the sign-in, the stored authorization
 * and running sandboxes stay as they are, and enabling or disabling the connection is a separate action.
 */
function DefaultSwitch({
  connection,
  onResult,
}: {
  connection: McpConnection;
  onResult: (result: ActionResult) => void;
}) {
  const [state, formAction, pending] = useActionState(updateConnectionMetadata, null);
  useEffect(() => {
    if (state) onResult(state);
  }, [state, onResult]);
  const on = pending ? !connection.defaultForLaunch : connection.defaultForLaunch;
  return (
    <form action={formAction} className="flex items-center">
      <input type="hidden" name="org" value={connection.orgId} />
      <input type="hidden" name="id" value={connection.id} />
      <input type="hidden" name="default_for_launch" value={String(!connection.defaultForLaunch)} />
      <button
        type="submit"
        role="switch"
        aria-checked={on}
        aria-label={`Include ${connection.name} by default`}
        disabled={pending}
        className="group flex items-center gap-2 rounded-md px-1 py-1 text-xs text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
      >
        <span
          className={cn(
            "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors",
            on ? "border-primary bg-primary" : "border-transparent bg-input dark:bg-input/80",
          )}
        >
          <span
            className={cn(
              "absolute size-3 rounded-full bg-background shadow-sm transition-transform motion-reduce:transition-none",
              on ? "translate-x-3.5" : "translate-x-0.5",
            )}
          />
        </span>
        Default
      </button>
    </form>
  );
}

type RowDialog = "rename" | "edit" | "revoke" | "delete" | null;

/**
 * A connection's one expected action on its row of the Tools list (#808): sign in for the first time, sign in
 * again, try again or configure. Its outcome is said under it. Everything else is in {@link ToolPanel}.
 */
export function ToolRowAction({ connection }: { connection: McpConnection }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const primary = connectAction(connection);
  return (
    <div className="flex flex-col items-end gap-1">
      {/* Stays mounted when it no longer applies, so the result of the connect it just ran is still shown. */}
      <RowAction
        action={connectConnection}
        fields={{ org: connection.orgId, id: connection.id }}
        onResult={setResult}
        variant={primary === "Retry" ? "outline" : "default"}
        label={`${primary ?? "Connect"} ${connection.name}`}
        hidden={primary === null}
      >
        {primary === "Retry" && <RefreshCwIcon />}
        {primary ?? "Connect"}
      </RowAction>
      <ResultLine result={result} className="max-w-56 text-right text-xs" />
    </div>
  );
}

/**
 * Everything rare about one connection, in the Tools page's detail panel: where it points, how it signs in, what it
 * exposes, its last error, the launch default, and its management (rename, edit, check, sign in again, enable or
 * disable, revoke, delete). A member who does not manage it reads the same facts without the controls.
 */
export function ToolPanel({
  connection,
  canManage,
  serviceLabel,
}: {
  connection: McpConnection;
  canManage: boolean;
  /** The catalog service's label, when the connection was created from the catalog. */
  serviceLabel?: string | undefined;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<RowDialog>(null);
  const [, startTransition] = useTransition();
  const target = { org: connection.orgId, id: connection.id };
  const remote = connection.transport !== "stdio";
  const enabled = connection.status !== "disabled";
  const custom = !connection.catalogId;
  const primary = connectAction(connection);
  const counts = remote
    ? [
        ["tool", connection.toolCount],
        ["resource", connection.resourceCount],
        ["prompt", connection.promptCount],
      ]
        .filter((entry): entry is [string, number] => entry[1] !== undefined)
        .map(([noun, count]) => `${count} ${count === 1 ? noun : `${noun}s`}`)
        .join(" · ")
    : "";

  /** Runs an action that never navigates, reporting on the panel's live line. */
  function run(action: Action, fields: Record<string, string>, pendingText: string) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    setBusy(pendingText);
    startTransition(async () => {
      const outcome = await action(null, data);
      setBusy(null);
      setResult(outcome);
    });
  }

  // Stable, so a dialog's success effect runs once per result rather than on every render of the panel.
  const closeDialog = useCallback((next: boolean) => {
    if (!next) setDialog(null);
  }, []);
  // A dialog closes back onto the button that opened it.
  const opener = useRef<HTMLElement | null>(null);
  const restoreFocus = useCallback((event: Event) => {
    event.preventDefault();
    opener.current?.focus();
  }, []);
  function open(next: RowDialog) {
    return (event: { currentTarget: HTMLElement }) => {
      opener.current = event.currentTarget;
      setDialog(next);
    };
  }

  return (
    <div className="space-y-4" data-connection-panel={connection.name}>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <ConnectionStatusBadge connection={connection} />
          <ScopeBadge scope={connection.scope} />
        </div>
        {connection.lastError && <p className="text-sm text-destructive">{connection.lastError}</p>}
        {canManage && primary && (
          <RowAction
            action={connectConnection}
            fields={target}
            onResult={setResult}
            variant={primary === "Retry" ? "outline" : "default"}
          >
            {primary === "Retry" && <RefreshCwIcon />}
            {primary}
          </RowAction>
        )}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t pt-4 text-sm">
        {serviceLabel && (
          <>
            <dt className="text-muted-foreground">Service</dt>
            <dd>{serviceLabel}</dd>
          </>
        )}
        <dt className="text-muted-foreground">{remote ? "URL" : "Command"}</dt>
        <dd className="font-mono text-xs break-all">
          {remote
            ? (connection.url ?? "Hidden")
            : [connection.command, ...(connection.args ?? [])].filter(Boolean).join(" ")}
        </dd>
        <dt className="text-muted-foreground">Transport</dt>
        <dd>{transportLabel(connection.transport)}</dd>
        {remote && (
          <>
            <dt className="text-muted-foreground">Sign-in</dt>
            <dd>{authLabel(connection.authType)}</dd>
          </>
        )}
        {connection.accountLabel && (
          <>
            <dt className="text-muted-foreground">Signed in as</dt>
            <dd className="break-all">{connection.accountLabel}</dd>
          </>
        )}
        {counts && (
          <>
            <dt className="text-muted-foreground">Exposes</dt>
            <dd>{counts}</dd>
          </>
        )}
      </dl>
      <div className="border-t pt-4">
        {canManage ? (
          <DefaultSwitch connection={connection} onResult={setResult} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {connection.defaultForLaunch ? (
              <Badge variant="secondary" data-default-for-launch>
                Default
              </Badge>
            ) : (
              "Not included by default."
            )}
          </p>
        )}
      </div>
      {canManage ? (
        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button variant="outline" size="sm" onClick={open("rename")}>
            <PencilIcon /> Rename
          </Button>
          {custom && (
            <Button variant="outline" size="sm" onClick={open("edit")}>
              <SettingsIcon /> Edit server
            </Button>
          )}
          {remote && enabled && connection.authType === "oauth" && connection.status === "connected" && (
            <Button variant="outline" size="sm" onClick={() => run(connectConnection, target, "Opening sign-in…")}>
              <LogInIcon /> Sign in again
            </Button>
          )}
          {remote && (
            <Button variant="outline" size="sm" onClick={() => run(checkConnection, target, "Checking…")}>
              <RefreshCwIcon /> Check
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              run(setConnectionEnabled, { ...target, enabled: String(!enabled) }, enabled ? "Disabling…" : "Enabling…")
            }
          >
            <PowerIcon /> {enabled ? "Disable" : "Enable"}
          </Button>
          {remote && connection.authType !== "none" && (
            <Button variant="destructive-outline" size="sm" onClick={open("revoke")}>
              <KeyRoundIcon /> Revoke access
            </Button>
          )}
          <Button variant="destructive-outline" size="sm" onClick={open("delete")}>
            <Trash2Icon /> Delete
          </Button>
        </div>
      ) : (
        <p className="border-t pt-4 text-xs text-muted-foreground">Managed by the org's admins.</p>
      )}
      <div className="empty:hidden">
        {busy ? (
          <p role="status" className="text-sm text-muted-foreground">
            {busy}
          </p>
        ) : (
          <ResultLine result={result} />
        )}
      </div>

      {canManage && (
        <>
          <RenameDialog
            connection={connection}
            open={dialog === "rename"}
            onOpenChange={closeDialog}
            onResult={setResult}
            onCloseAutoFocus={restoreFocus}
          />
          {custom && (
            <EditConnectionDialog
              connection={connection}
              open={dialog === "edit"}
              onOpenChange={closeDialog}
              onResult={setResult}
              onCloseAutoFocus={restoreFocus}
            />
          )}
          <ConfirmAction
            open={dialog === "revoke"}
            onOpenChange={closeDialog}
            onCloseAutoFocus={restoreFocus}
            action={revokeConnection}
            fields={target}
            onResult={setResult}
            title={`Revoke access to ${connection.name}?`}
            description="Armada deletes the stored authorization. Sandboxes launched later cannot use the server until someone connects it again. The definition stays."
            confirm="Revoke access"
          />
          <ConfirmAction
            open={dialog === "delete"}
            onOpenChange={closeDialog}
            onCloseAutoFocus={restoreFocus}
            action={deleteConnection}
            fields={target}
            onResult={setResult}
            title={`Delete ${connection.name}?`}
            description="The connection and its stored authorization are removed. New launches can no longer select it."
            confirm="Delete connection"
          />
        </>
      )}
    </div>
  );
}

type ControlledDialog = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
};

function ConfirmAction({
  open,
  onOpenChange,
  onCloseAutoFocus,
  action,
  fields,
  onResult,
  title,
  description,
  confirm,
}: ControlledDialog & {
  action: Action;
  fields: Record<string, string>;
  onResult: (result: ActionResult) => void;
  title: string;
  description: string;
  confirm: string;
}) {
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (!state) return;
    onResult(state);
    if (state.ok) onOpenChange(false);
  }, [state, onResult, onOpenChange]);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
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

/** Renames a connection. Metadata only: its sign-in and every running sandbox keep working. */
function RenameDialog({
  connection,
  open,
  onOpenChange,
  onCloseAutoFocus,
  onResult,
}: ControlledDialog & { connection: McpConnection; onResult: (result: ActionResult) => void }) {
  const [state, formAction] = useActionState(updateConnectionMetadata, null);
  const id = useId();
  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      onResult(state);
      onOpenChange(false);
    }
  }, [state, onResult, onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Rename {connection.name}</DialogTitle>
          <DialogDescription>Only the name changes. Sign-in and running sandboxes are kept.</DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="org" value={connection.orgId} />
          <input type="hidden" name="id" value={connection.id} />
          <div className="space-y-2">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              name="name"
              defaultValue={connection.name}
              required
              maxLength={120}
              autoComplete="off"
            />
          </div>
          {state && !state.ok && <ResultLine result={state} />}
          <div className="flex justify-end">
            <SubmitButton>Rename</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Edits a custom connection's server. The server clears its stored authentication and revokes running leases on
 * any update, which the dialog says before the person saves; a remote connection is then connected again.
 */
function EditConnectionDialog({
  connection,
  open,
  onOpenChange,
  onCloseAutoFocus,
  onResult,
}: ControlledDialog & { connection: McpConnection; onResult: (result: ActionResult) => void }) {
  const [state, formAction] = useActionState(editConnection, null);
  const [generation, setGeneration] = useState(0);
  const [authType, setAuthType] = useState<ConnectionAuthType>(connection.authType);
  const id = useId();
  useEffect(() => {
    if (!state) return;
    onResult(state);
    if (state.ok) {
      onOpenChange(false);
      setGeneration((value) => value + 1);
    }
  }, [state, onResult, onOpenChange]);
  const remote = connection.transport !== "stdio";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
        onCloseAutoFocus={onCloseAutoFocus}
      >
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
              Saving replaces the server below. Any saved sign-in, token or headers are deleted, not kept, and sandboxes
              using the connection lose it now. To change only the name, use Rename.
            </span>
          </p>
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
