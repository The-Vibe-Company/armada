import { MODELS_MINOR } from "@armada/protocol";
import { ChevronRight } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Input } from "@/components/page";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDaemon, useDaemonClient } from "@/protocol/store";
import { SettingsFold, SettingsRow, SettingsSection, StateDot } from "./Layout";
import { ModelPicker } from "./ModelPicker";
import { ProviderMark } from "./marks";
import {
  type CatalogProvider,
  isConnected,
  isUsable,
  piSelection,
  projectOverride,
  providerOrder,
  providerState,
  selectionLabel,
} from "./models";
import { type SignIn, SignInPanel, useSignIn } from "./ProviderSignIn";

/** The two sign-ins the section opens on, after T3 Code's Codex setup. */
const CHATGPT = "openai-codex";
const CLAUDE = "anthropic";

/**
 * Settings' Coordinator (THE-2070): the model every coordinator thinks with,
 * from pi's providers as the daemon lists them (THE-2073). It opens on one
 * choice, Continue with ChatGPT or with Claude, an API key for any other
 * provider below; then the model, picked from the catalog, and each project's
 * own; the OpenAI-compatible endpoint folded at the bottom. A daemon without
 * the catalog keeps the key form alone. A key or an answer lives only in its
 * field until one explicit submit: never in app state or storage.
 */
export function Coordinator() {
  const { catalog } = useDaemon();
  if (!catalog) return <CustomEndpoint />;
  return (
    <>
      <Connect providers={catalog.providers} />
      <Model />
      <SettingsSection title="Custom endpoint">
        <SettingsRow
          title="OpenAI-compatible endpoint"
          description="A model behind an endpoint of your own, through the model plugins. Applies when the daemon restarts."
        >
          <SettingsFold label="Set up a custom endpoint">
            <CustomEndpoint folded />
          </SettingsFold>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

/** Connect: the two Continue buttons until a provider is connected, then a row per connected one; the providers below. */
function Connect({ providers }: { providers: readonly CatalogProvider[] }) {
  const signIn = useSignIn();
  const [listed, setListed] = useState(false);
  const ordered = providerOrder(providers);
  const connected = ordered.filter(isConnected);
  const others = ordered.filter((p) => !isConnected(p));
  const starters = [CHATGPT, CLAUDE].flatMap((id) => {
    const provider = providers.find((p) => p.id === id && p.auth.oauth && !isConnected(p));
    return provider ? [provider] : [];
  });
  const signingIn = signIn.view ? providers.find((p) => p.id === signIn.view?.provider) : undefined;
  const fromStarter = connected.length === 0 && starters.some((p) => p.id === signingIn?.id);
  // A sign-in started from the list keeps the list open: its panel (and Cancel) is in its row.
  const fromList = signingIn !== undefined && !fromStarter && others.some((p) => p.id === signingIn.id);
  const shown = listed || fromList;
  return (
    <>
      <SettingsSection
        title="Connect"
        end={
          connected.length > 0 &&
          others.length > 0 && (
            <Button variant="ghost" aria-expanded={shown} disabled={fromList} onClick={() => setListed(!listed)}>
              {shown ? "Hide providers" : "Add another"}
            </Button>
          )
        }
      >
        {connected.length === 0 ? (
          <div className="flex min-w-0 flex-col gap-4 px-4 py-4">
            <p className="m-0 text-text-2">
              Sign in to the model your coordinators think with. Your sign-in and keys stay on this device.
            </p>
            {starters.length > 0 && (
              <div className="grid grid-cols-1 gap-3 @min-[32rem]/settings:grid-cols-2">
                {starters.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    data-continue={provider.id}
                    disabled={signIn.busy}
                    onClick={() => signIn.start(provider.id)}
                    className="flex h-12 cursor-pointer items-center justify-center gap-2.5 rounded-control bg-card px-4 font-medium text-sub text-text shadow-control outline-none transition-[background-color,box-shadow,scale] ease-out hover:not-disabled:bg-panel-3 hover:not-disabled:shadow-control-hover focus-visible:ring-2 focus-visible:ring-blue disabled:cursor-default disabled:opacity-50 motion-safe:active:not-disabled:scale-98"
                  >
                    <ProviderMark provider={provider.id} className="size-4.5" />
                    {provider.id === CHATGPT ? "Continue with ChatGPT" : "Continue with Claude"}
                  </button>
                ))}
              </div>
            )}
            {fromStarter && signingIn && <SignInPanel signIn={signIn} name={signingIn.name} />}
            {others.length > 0 && (
              <button
                type="button"
                aria-expanded={shown}
                disabled={fromList}
                onClick={() => setListed(!listed)}
                className="-mx-1 flex h-7 w-fit cursor-pointer items-center gap-1 rounded-sm px-1 text-small text-text-2 outline-none hover:not-disabled:text-text focus-visible:ring-2 focus-visible:ring-blue disabled:cursor-default"
              >
                <ChevronRight
                  aria-hidden
                  className={cn("size-3.5 transition-transform motion-reduce:transition-none", shown && "rotate-90")}
                />
                Or use an API key
              </button>
            )}
          </div>
        ) : (
          connected.map((provider) => <ConnectedRow key={provider.id} provider={provider} />)
        )}
      </SettingsSection>
      {shown && others.length > 0 && (
        <SettingsSection title="Providers" count={others.length}>
          {others.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} signIn={signIn} panel={!fromStarter} />
          ))}
        </SettingsSection>
      )}
    </>
  );
}

function ProviderName({ provider }: { provider: CatalogProvider }) {
  return (
    <>
      <ProviderMark provider={provider.id} className="self-center" />
      <span className="truncate">{provider.name}</span>
    </>
  );
}

function State({ provider }: { provider: CatalogProvider }) {
  const state = providerState(provider);
  return state ? <StateDot {...state} /> : null;
}

/** A connected provider: its mark, name, state on a green dot, and the way out. */
function ConnectedRow({ provider }: { provider: CatalogProvider }) {
  const client = useDaemonClient();
  const { status } = useDaemon();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function leave() {
    setBusy(true);
    setProblem(null);
    try {
      await client.logout(provider.id);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The daemon could not sign out.");
      setBusy(false);
    }
  }
  return (
    <SettingsRow
      data-provider={provider.id}
      title={<ProviderName provider={provider} />}
      status={
        <>
          <State provider={provider} />
          <Problem>{problem}</Problem>
        </>
      }
      control={
        <Button variant="soft" disabled={busy || status !== "live"} onClick={leave}>
          {provider.status === "signed-in" ? "Sign out" : "Remove key"}
        </Button>
      }
    />
  );
}

/** A provider not connected: Sign in when it has one, its key field when it takes a key. */
function ProviderRow({ provider, signIn, panel }: { provider: CatalogProvider; signIn: SignIn; panel: boolean }) {
  const client = useDaemonClient();
  const { status } = useDaemon();
  const field = useId();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const signingIn = panel && signIn.view?.provider === provider.id;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const key = String(new FormData(form).get("key") ?? "").trim();
    // Clear the field before awaiting the daemon, including on error. Never replayed after a drop.
    form.reset();
    if (!key) return;
    setSaving(true);
    setProblem(null);
    try {
      await client.saveCredentials(provider.id, key, undefined, "pi");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The key was not saved. Try again.");
    } finally {
      setSaving(false);
    }
  }
  const env = provider.auth.envVars[0];
  return (
    <SettingsRow
      data-provider={provider.id}
      title={<ProviderName provider={provider} />}
      description={
        provider.status === "unconfigured" && env ? (
          <>
            Or set <span className="font-mono">{env}</span> in the daemon's environment.
          </>
        ) : undefined
      }
      status={
        <>
          <State provider={provider} />
          <Problem>{problem}</Problem>
        </>
      }
      control={
        (provider.auth.oauth || provider.auth.apiKey) && (
          <>
            {provider.auth.apiKey && (
              <form onSubmit={save} className="m-0 flex min-w-0 items-center gap-2">
                <label htmlFor={field} className="sr-only">
                  {provider.name} API key
                </label>
                <Input
                  id={field}
                  name="key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  maxLength={8192}
                  pattern="[^\s]+"
                  placeholder="Paste an API key"
                  disabled={saving}
                  className="w-48 min-w-0"
                />
                <Button type="submit" variant="soft" disabled={saving || status !== "live"}>
                  {saving ? "Saving…" : "Save key"}
                </Button>
              </form>
            )}
            {provider.auth.oauth && (
              <Button
                variant="soft"
                disabled={signIn.busy || status !== "live"}
                onClick={() => signIn.start(provider.id)}
              >
                Sign in
              </Button>
            )}
          </>
        )
      }
    >
      {signingIn && (
        <div className="pt-1 pb-3">
          <SignInPanel signIn={signIn} name={provider.name} />
        </div>
      )}
    </SettingsRow>
  );
}

/** Model: the default every coordinator thinks with, and each project's own from its rules. */
function Model() {
  const { catalog, projects, fleets, status } = useDaemon();
  const client = useDaemonClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!catalog) return null;
  const providers = catalog.providers;
  const usable = providers.some(isUsable);
  const label = selectionLabel(catalog.selected, providers) ?? (usable ? "Choose a model" : "Connect a provider first");
  async function select(provider: string, model: string) {
    setSaving(true);
    setProblem(null);
    try {
      await client.select(provider, model);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The model was not saved. Try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsSection title="Model">
      <SettingsRow
        data-setting="model"
        title="Model"
        description="The model every coordinator thinks with, unless its project names its own."
        status={<Problem>{problem}</Problem>}
        control={
          <ModelPicker
            providers={providers}
            selected={piSelection(catalog.selected)}
            label={label}
            disabled={!usable || saving || status !== "live"}
            onSelect={select}
          />
        }
      />
      <SettingsRow
        data-setting="per-project"
        title="Per project"
        description="A project's rules can name its own coordinator model. Ask the coordinator in the room to change it."
      >
        {projects && projects.length > 0 ? (
          <ul className="m-0 flex list-none flex-col p-0 pb-2">
            {projects.map((project) => {
              const override = projectOverride(fleets[project.id]?.state);
              return (
                <li
                  key={project.id}
                  data-project-model={project.id}
                  className="flex min-w-0 items-center justify-between gap-4 py-1.5"
                >
                  <span className="min-w-0 truncate text-text">{project.name}</span>
                  {override ? (
                    <span className="flex min-w-0 items-center gap-1.5 text-text-soft">
                      {"provider" in override && <ProviderMark provider={override.provider} className="size-3.5" />}
                      <span className="truncate">{selectionLabel(override, providers)}</span>
                    </span>
                  ) : (
                    <span className="text-text-3">Default</span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="m-0 pb-2 text-small text-text-3">No project yet.</p>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return children ? (
    <p role="alert" className="m-0 pt-1 text-red">
      {children}
    </p>
  ) : null;
}

/**
 * The model plugins' key form (THE-1995), as it was: the OpenAI-compatible
 * endpoint (or any loaded model plugin) with its model, base URL and key.
 * Alone on a daemon without pi's catalog; folded under Custom endpoint otherwise.
 */
function CustomEndpoint({ folded = false }: { folded?: boolean }) {
  const { credentials, status, plugins, minor } = useDaemon();
  const client = useDaemonClient();
  const field = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!credentials) return null;
  const catalog = plugins?.plugins;
  const hasCatalog =
    credentials.models !== undefined ||
    catalog?.some((plugin) => plugin.contributions.some((entry) => entry.seam === "model")) === true;
  const models =
    catalog && hasCatalog
      ? catalog.flatMap((plugin) =>
          plugin.loaded
            ? plugin.contributions
                .filter((entry) => entry.seam === "model")
                .map((entry) => ({
                  kind: entry.kind,
                  description: entry.description ?? entry.kind,
                  config: credentials.models?.find((model) => model.kind === entry.kind)?.config ?? entry.schema,
                }))
            : [],
        )
      : (credentials.models ?? []);
  const chosen = models.find((entry) => entry.kind === (selected ?? credentials.provider)) ?? models[0];
  const schema = chosen?.config as
    | { required?: string[]; properties?: Record<string, { default?: string }> }
    | undefined;
  const defaults = schema?.properties ?? {};
  const savedConfig = chosen?.kind === credentials.provider ? credentials.config : undefined;
  const provider = models.find((entry) => entry.kind === credentials.provider)?.description ?? credentials.provider;
  const saved = credentials.provider !== null && !editing;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setSaving(true);
    setProblem(null);
    const model = String(values.get("model") ?? "").trim();
    const baseURL = String(values.get("baseURL") ?? "").trim();
    const request = client.saveCredentials(
      String(values.get("provider")),
      String(values.get("key")),
      {
        ...(model ? { model } : {}),
        ...(baseURL ? { baseURL } : {}),
      },
      // A daemon with pi's catalog reads a key without a target as pi's: this one is the plugin's.
      (minor ?? 0) >= MODELS_MINOR ? "plugin" : undefined,
    );
    // Clear the DOM before awaiting the daemon, including on error. Never replay after reconnect.
    form.reset();
    try {
      await request;
      setEditing(false);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Key could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const control = "h-10 w-full rounded-control bg-sunken px-3 text-body text-text shadow-ring";
  const body = (
    <>
      {credentials.needsRepair && (
        <p className="text-text-2">
          The saved model setting could not be read. Choose a provider and save a replacement key.
        </p>
      )}
      {saved ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="m-0 text-text-2">
            <span className="text-green">{provider} connected.</span>{" "}
            {credentials.storage === "os-keychain"
              ? "Key saved in your OS keychain."
              : "Key saved privately on this device."}{" "}
            Restart the daemon to apply model changes.
          </p>
          {folded && (
            <Button
              onClick={() => {
                setEditing(true);
                setProblem(null);
              }}
            >
              Change key
            </Button>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className={cn("flex max-w-[560px] flex-col gap-4", !folded && "mt-3")}>
          <p id={`${field}-help`} className="m-0 text-text-2">
            Choose a provider to connect your coordinator. Your API key stays on this device.
          </p>
          <div className="flex flex-wrap gap-3">
            <label className="flex min-w-36 flex-1 flex-col gap-2" htmlFor={`${field}-provider`}>
              Provider
              {hasCatalog ? (
                <select
                  id={`${field}-provider`}
                  name="provider"
                  value={chosen?.kind ?? ""}
                  onChange={(event) => setSelected(event.currentTarget.value)}
                  className={control}
                  disabled={saving || models.length === 0}
                >
                  {models.map((entry) => (
                    <option key={entry.kind} value={entry.kind}>
                      {entry.description}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`${field}-provider`}
                  name="provider"
                  defaultValue={credentials.provider ?? ""}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  className={control}
                  disabled={saving}
                />
              )}
            </label>
            <label className="flex min-w-48 flex-[2] flex-col gap-2" htmlFor={`${field}-key`}>
              API key
              <input
                id={`${field}-key`}
                name="key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                maxLength={8192}
                pattern="[^\s]+"
                aria-describedby={`${field}-help`}
                placeholder="Paste your API key"
                className={control}
                disabled={saving}
              />
            </label>
          </div>
          {hasCatalog && models.length === 0 && (
            <p className="m-0 text-text-2">Enable a model plugin and restart the daemon to connect your coordinator.</p>
          )}
          {!hasCatalog && (
            <p className="m-0 text-text-2">
              This daemon does not list model plugins. Enter its provider kind, or update the daemon to choose from a
              list.
            </p>
          )}
          {hasCatalog && (
            <>
              <label className="flex flex-col gap-2" htmlFor={`${field}-model`}>
                Model
                <input
                  id={`${field}-model`}
                  name="model"
                  key={`${chosen?.kind}-model`}
                  required={schema?.required?.includes("model")}
                  defaultValue={savedConfig?.model ?? defaults.model?.default ?? ""}
                  placeholder="Model or deployment name"
                  className={control}
                  disabled={saving}
                />
              </label>
              <label className="flex flex-col gap-2" htmlFor={`${field}-url`}>
                Endpoint (if required by your provider)
                <input
                  id={`${field}-url`}
                  name="baseURL"
                  key={`${chosen?.kind}-baseURL`}
                  type="url"
                  required={schema?.required?.includes("baseURL")}
                  defaultValue={savedConfig?.baseURL ?? defaults.baseURL?.default ?? ""}
                  placeholder="https://api.example.com/v1"
                  className={control}
                  disabled={saving}
                />
              </label>
            </>
          )}
          {problem && (
            <p role="alert" className="m-0 text-red">
              {problem}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={saving || status !== "live" || (hasCatalog && models.length === 0)}
            >
              {saving ? "Saving…" : "Save key"}
            </Button>
            {editing && (
              <Button
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setProblem(null);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </>
  );
  if (folded) return <div className="flex min-w-0 flex-col gap-3">{body}</div>;
  return (
    <section aria-labelledby={`${field}-title`} className="rounded-card bg-card p-5 shadow-ring">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${field}-title`} className="m-0 font-medium text-sub">
          Coordinator model
        </h2>
        {saved && (
          <Button
            onClick={() => {
              setEditing(true);
              setProblem(null);
            }}
          >
            Change key
          </Button>
        )}
      </div>
      {body}
    </section>
  );
}
