import type { Provider } from "@armada/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { type Connection, settingsHref } from "@/lib/route";
import { useDaemon, useDaemonClient } from "@/protocol/store";
import { Account, beginSignIn } from "./Account";
import { Card, detailId, go, useEscapeCloses } from "./Card";
import { SettingsRow, SettingsSection, StateDot } from "./Layout";
import { Mark } from "./marks";
import { type SignIn, SignInPanel, useSignIn, useSignInFollows } from "./ProviderSignIn";
import { connectionStatus, type StatusLine, sourceLabel } from "./provider-view";

const NAMES: Record<Connection, string> = { linear: "Linear", github: "GitHub", armada: "Armada" };
const SEAMS = { linear: "tracker", github: "forge" } as const;

/** The catalog's Linear or GitHub connection. */
const connectionOf = (providers: readonly Provider[] | null, card: "linear" | "github") =>
  providers?.find((p) => p.seam === SEAMS[card] && p.mark === card);

/**
 * Settings › Connections (THE-2075, after T3 Code's ConnectionsSettings): the
 * places Armada reads tickets and code, and the sign-in to Armada web, as the
 * Providers' cards. Linear and GitHub connect in one click (`providers.connect`:
 * Linear asks for its key, or reads the organization's when the Armada
 * account provides it; GitHub runs `gh auth login` or asks for a token) and
 * disconnect (`providers.disconnect`); Armada's detail is THE-2071's Account.
 * The open card's detail is below the list (`#/settings/connections/<card>`).
 */
export function Connections({ detail }: { detail?: Connection }) {
  const { providers, providersProblem, account, accountProblem, status } = useDaemon();
  const client = useDaemonClient();
  const signIn = useSignIn("provider");
  useEscapeCloses(detail, () => go(settingsHref("connections")));
  useSignInFollows(
    signIn,
    detail === "linear" || detail === "github" ? connectionOf(providers, detail)?.id : undefined,
  );
  const live = status === "live";
  const toggle = (card: Connection) => go(settingsHref("connections", card === detail ? undefined : card));
  const armadaKey = account?.signedIn === true && account.keys.linear;
  function connect(card: "linear" | "github") {
    const provider = connectionOf(providers, card);
    if (!provider) return;
    signIn.start(provider.id);
    go(settingsHref("connections", card));
  }
  return (
    <>
      {providersProblem && (
        <div role="alert" className="rounded-card bg-card px-4 py-3 text-amber shadow-ring">
          {providersProblem}
        </div>
      )}
      <SettingsSection title="Connections">
        {(["linear", "github"] as const).map((card) => {
          const provider = connectionOf(providers, card);
          return (
            <Card
              key={card}
              id={card}
              mark={card}
              name={NAMES[card]}
              status={providers ? connectionStatus(provider) : READING}
              open={detail === card}
              onToggle={() => toggle(card)}
              control={
                provider && (
                  <ConnectionAction
                    provider={provider}
                    name={NAMES[card]}
                    live={live}
                    busy={signIn.busy}
                    connectLabel={card === "linear" && armadaKey ? "Use Armada's key" : "Connect"}
                    onConnect={() => connect(card)}
                  />
                )
              }
            />
          );
        })}
        <Card
          id="armada"
          mark="armada"
          name="Armada"
          status={
            !account
              ? { ...READING, word: accountProblem ?? "Reading the sign-in…" }
              : account.signedIn
                ? {
                    word: `Signed in as ${account.email}`,
                    dot: "bg-green",
                    ink: "text-text-2",
                    detail: account.organization.name,
                  }
                : { word: "Not signed in", dot: "bg-text-3", ink: "text-text-3" }
          }
          open={detail === "armada"}
          onToggle={() => toggle("armada")}
          control={
            account?.signedIn === false && (
              <Button
                variant="soft"
                disabled={!live}
                onClick={() => {
                  go(settingsHref("connections", "armada"));
                  void beginSignIn(client);
                }}
              >
                Sign in
              </Button>
            )
          }
        />
      </SettingsSection>
      {detail === "armada" ? (
        <div id={detailId("armada")} data-detail="armada" className="flex min-w-0 flex-col gap-7">
          <Account />
        </div>
      ) : detail ? (
        <ConnectionDetail
          key={detail}
          card={detail}
          provider={connectionOf(providers, detail)}
          signIn={signIn}
          live={live}
          armadaKey={detail === "linear" && armadaKey}
          onConnect={() => connect(detail)}
        />
      ) : null}
    </>
  );
}

const READING: StatusLine = { word: "Reading…", dot: "bg-text-3", ink: "text-text-3" };

/** Connect (or Use Armada's key) when not connected, Disconnect when connected. */
function ConnectionAction({
  provider,
  name,
  live,
  busy,
  connectLabel,
  onConnect,
}: {
  provider: Provider;
  name: string;
  live: boolean;
  busy: boolean;
  connectLabel: string;
  onConnect: () => void;
}) {
  const disconnect = useDisconnect(provider);
  if (provider.state === "connected")
    return (
      <>
        {disconnect.problem && (
          <span role="alert" className="max-w-56 truncate text-small text-red" title={disconnect.problem}>
            {disconnect.problem}
          </span>
        )}
        <Button
          variant="ghost"
          aria-label={`Disconnect ${name}`}
          disabled={!live || disconnect.leaving}
          onClick={disconnect.run}
        >
          {disconnect.leaving ? "Disconnecting…" : "Disconnect"}
        </Button>
      </>
    );
  if (provider.state === "disconnected")
    return (
      <Button variant="soft" disabled={!live || busy} onClick={onConnect}>
        {connectLabel}
      </Button>
    );
  return null;
}

function useDisconnect(provider: Provider) {
  const client = useDaemonClient();
  const [leaving, setLeaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return {
    leaving,
    problem,
    run() {
      setLeaving(true);
      setProblem(null);
      client
        .disconnectProvider(provider.id)
        .catch((error: unknown) => setProblem(error instanceof Error ? error.message : "Disconnect failed."))
        .finally(() => setLeaving(false));
    },
  };
}

/** Linear's or GitHub's detail: its status, where its key comes from, Connect or Disconnect, and the sign-in in place. */
function ConnectionDetail({
  card,
  provider,
  signIn,
  live,
  armadaKey,
  onConnect,
}: {
  card: "linear" | "github";
  provider: Provider | undefined;
  signIn: SignIn;
  live: boolean;
  armadaKey: boolean;
  onConnect: () => void;
}) {
  const disconnect = useDisconnect(provider ?? ({ id: card } as Provider));
  const name = NAMES[card];
  const status = connectionStatus(provider);
  return (
    <div id={detailId(card)} data-detail={card} className="flex min-w-0 flex-col gap-7">
      <SettingsSection
        title={
          <span className="flex items-center gap-2">
            <Mark mark={card} />
            <span>{name}</span>
          </span>
        }
      >
        <SettingsRow
          title="Status"
          data-row="status"
          description={
            provider?.state === "connected" && provider.detail
              ? `${sourceLabel(provider.detail)}.`
              : card === "linear"
                ? armadaKey
                  ? "The organization's Linear key, from your Armada account, or a key of your own."
                  : "A personal API key from Linear's settings."
                : "The gh CLI's sign-in, or a token."
          }
          status={
            <>
              <StateDot word={status.word} dot={status.dot} ink={status.ink} />
              {disconnect.problem && (
                <p role="alert" className="m-0 pt-1 text-red">
                  {disconnect.problem}
                </p>
              )}
            </>
          }
          control={
            provider?.state === "connected" ? (
              <Button disabled={!live || disconnect.leaving} onClick={disconnect.run}>
                {disconnect.leaving ? "Disconnecting…" : "Disconnect"}
              </Button>
            ) : provider?.state === "disconnected" && signIn.view?.provider !== provider.id ? (
              <Button variant="primary" disabled={!live || signIn.busy} onClick={onConnect}>
                {armadaKey ? "Use Armada's key" : "Connect"}
              </Button>
            ) : undefined
          }
        >
          {provider && signIn.view?.provider === provider.id && (
            <div className="pb-3">
              <SignInPanel signIn={signIn} name={name} />
            </div>
          )}
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

/** The facts line: how many of the three are connected. */
export function ConnectionsFacts() {
  const { providers, account } = useDaemon();
  const connected =
    (["linear", "github"] as const).filter((card) => connectionOf(providers, card)?.state === "connected").length +
    (account?.signedIn ? 1 : 0);
  return <span>{connected} of 3 connected</span>;
}
