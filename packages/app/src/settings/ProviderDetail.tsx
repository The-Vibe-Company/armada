import type { Provider } from "@armada/protocol";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/page";
import { Button } from "@/components/ui/button";
import { roomHref } from "@/lib/route";
import { useDaemon, useDaemonClient } from "@/protocol/store";
import { detailId } from "./Card";
import { setDisplayName, useDisplayName } from "./display-names";
import { SettingsRow, SettingsSection, StateDot } from "./Layout";
import { Mark } from "./marks";
import { type SignIn, SignInPanel } from "./ProviderSignIn";
import { agentStatus, binaryConfig, routesTo, runtimeOf, versionLabel } from "./provider-view";

/** The card whose detail opens on Sign in: an agent just turned on while signed out. */
let focusSignIn: string | null = null;
export const focusSignInOf = (id: string) => {
  focusSignIn = id;
};

/**
 * One agent's detail, below the list (THE-2075, after T3 Code's
 * ProviderInstanceCard's sections): its Status with Sign in or Sign out and
 * the sign-in in place, its Display name (local), its Binary path (saved with
 * `plugins.configure`) and the Routing rules that send it work, read-only.
 */
export function ProviderDetail({ provider, signIn }: { provider: Provider; signIn: SignIn }) {
  const { status: link } = useDaemon();
  const live = link === "live";
  const name = useDisplayName(provider.mark, provider.name);
  return (
    <div id={detailId(provider.id)} data-detail={provider.id} className="flex min-w-0 flex-col gap-7">
      <SettingsSection
        title={
          <span className="flex items-center gap-2">
            <Mark mark={provider.mark} />
            <span>{name}</span>
          </span>
        }
        end={
          versionLabel(provider.version) && (
            <code className="font-mono text-small text-text-3 tnum">{versionLabel(provider.version)}</code>
          )
        }
      >
        <Status provider={provider} name={name} signIn={signIn} live={live} />
        <DisplayName provider={provider} />
      </SettingsSection>
      <SettingsSection title="Runtime">
        <BinaryPath provider={provider} live={live} />
      </SettingsSection>
      <Routing provider={provider} name={name} />
    </div>
  );
}

function Status({ provider, name, signIn, live }: { provider: Provider; name: string; signIn: SignIn; live: boolean }) {
  const client = useDaemonClient();
  const button = useRef<HTMLButtonElement>(null);
  const [leaving, setLeaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const status = agentStatus(provider);
  const signingIn = signIn.view?.provider === provider.id;
  // Turned on while signed out: the focus waits on Sign in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the button waits for the catalog that says it is on.
  useEffect(() => {
    if (focusSignIn !== provider.id || !button.current || button.current.disabled) return;
    focusSignIn = null;
    button.current.focus();
  }, [provider.id, provider.enabled, provider.state, live]);
  async function signOut() {
    setLeaving(true);
    setProblem(null);
    try {
      await client.disconnectProvider(provider.id);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Sign-out failed. Try again.");
    } finally {
      setLeaving(false);
    }
  }
  return (
    <SettingsRow
      title="Status"
      data-row="status"
      description={
        provider.state === "missing"
          ? (provider.detail ?? `Install ${name}'s CLI on this device.`)
          : provider.state === "connected"
            ? provider.detail
            : !provider.enabled
              ? `Turn ${name} on to sign in.`
              : undefined
      }
      status={
        <>
          <StateDot
            word={status.word}
            dot={status.dot}
            ink={provider.state === "connected" ? "text-text" : status.ink}
          />
          {problem && (
            <p role="alert" className="m-0 pt-1 text-red">
              {problem}
            </p>
          )}
        </>
      }
      control={
        provider.state === "connected" ? (
          <Button disabled={leaving || !live} onClick={() => void signOut()}>
            {leaving ? "Signing out…" : "Sign out"}
          </Button>
        ) : provider.state === "disconnected" && !signingIn ? (
          <Button
            ref={button}
            variant="primary"
            disabled={!live || signIn.busy || !provider.enabled}
            onClick={() => signIn.start(provider.id)}
          >
            Sign in
          </Button>
        ) : undefined
      }
    >
      {signingIn && (
        <div className="pb-3">
          <SignInPanel signIn={signIn} name={name} />
        </div>
      )}
    </SettingsRow>
  );
}

/** The name this app gives the agent: in this browser only, shown in the room's rows. */
function DisplayName({ provider }: { provider: Provider }) {
  const id = useId();
  const name = useDisplayName(provider.mark, "");
  function commit(value: string) {
    if (value.trim() !== name) setDisplayName(provider.mark, value);
  }
  return (
    <SettingsRow
      title={<label htmlFor={id}>Display name</label>}
      description="How this app names the agent. Kept on this device."
      control={
        <form
          className="m-0 w-full @min-[32rem]/row:w-56"
          onSubmit={(event) => {
            event.preventDefault();
            commit(String(new FormData(event.currentTarget).get("name") ?? ""));
          }}
        >
          <Input
            // A name saved elsewhere (another window) remounts the field on it.
            key={name}
            id={id}
            name="name"
            defaultValue={name}
            placeholder={provider.name}
            maxLength={80}
            spellCheck={false}
            autoComplete="off"
            onBlur={(event) => commit(event.currentTarget.value)}
          />
        </form>
      }
    />
  );
}

/** Where the agent's CLI is: `config.binary`, saved into its runtime's config with `plugins.configure`. */
function BinaryPath({ provider, live }: { provider: Provider; live: boolean }) {
  const { plugins } = useDaemon();
  const client = useDaemonClient();
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const runtime = plugins ? runtimeOf(provider, plugins.plugins) : null;
  const plugin = runtime && plugins?.plugins.find((p) => p.id === runtime.plugin);
  // The daemon names the agent's own command when none is set: the field shows it as its placeholder.
  const binary = provider.config.binary === runtime?.kind ? "" : (provider.config.binary ?? "");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runtime || !plugin) return;
    const value = String(new FormData(event.currentTarget).get("binary") ?? "");
    setSaving(true);
    setProblem(null);
    setSaved(false);
    try {
      await client.configurePlugin(runtime.plugin, "runtime", runtime.kind, binaryConfig(plugin, runtime.kind, value));
      setSaved(true);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The path was not saved.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsRow
      title={<label htmlFor={id}>Binary path</label>}
      description="The command that starts the agent's CLI. Empty: the agent's own, found on the PATH."
      status={
        problem ? (
          <span role="alert" className="text-red">
            {problem}
          </span>
        ) : saved ? (
          <span role="status" className="text-text-2">
            Saved. Applies when the daemon restarts.
          </span>
        ) : undefined
      }
      control={
        <form onSubmit={submit} className="m-0 flex w-full items-center gap-2 @min-[32rem]/row:w-80">
          <Input
            key={binary}
            id={id}
            name="binary"
            defaultValue={binary}
            placeholder={runtime?.kind ?? provider.mark}
            spellCheck={false}
            autoComplete="off"
            maxLength={4096}
            className="font-mono"
            disabled={saving}
          />
          <Button type="submit" variant="soft" disabled={saving || !live || !runtime}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </form>
      }
    />
  );
}

/** The projects' rules that send work to this agent (their Rules tab changes them), read-only. */
function Routing({ provider, name }: { provider: Provider; name: string }) {
  const { projects, fleets } = useDaemon();
  const routes = routesTo(provider.mark, projects ?? [], fleets);
  const first = projects?.[0];
  return (
    <SettingsSection
      title="Routing"
      count={routes.length}
      end={
        first && (
          <a
            href={roomHref((routes[0]?.project ?? first.id) as string, "rules")}
            className="text-small text-text-2 underline decoration-line-strong underline-offset-2 hover:text-text"
          >
            Open Rules
          </a>
        )
      }
    >
      {routes.length === 0 ? (
        <SettingsRow
          title="No rule"
          description={`No project's rules send work to ${name}. Tell a coordinator which labels go to it.`}
        />
      ) : (
        routes.map((route, index) => (
          <SettingsRow
            // biome-ignore lint/suspicious/noArrayIndexKey: the rules are an ordered list that may repeat.
            key={index}
            data-route={route.project}
            title={
              route.labels ? (
                <span className="flex flex-wrap gap-1.5">
                  {route.labels.map((label) => (
                    <span key={label} className="rounded-xs bg-fill px-1.5 font-normal text-small text-text">
                      {label}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="font-normal">{route.when ?? "Every other ticket"}</span>
              )
            }
            description={
              <a href={roomHref(route.project, "rules")} className="text-text-2 hover:text-text hover:underline">
                {route.projectName}
              </a>
            }
            control={
              <span className="font-mono text-small text-text-soft">
                {route.model}
                {route.effort && <span className="text-text-3"> · {route.effort}</span>}
              </span>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}
